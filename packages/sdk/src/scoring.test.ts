import { describe, it, expect } from "bun:test";
import {
  updateBaseline,
  computeTaskScore,
  computeCredit,
  updateWeight,
  initialWeight,
  emptyBaseline,
} from "./scoring";
import type { TaskBaseline, MemoryCategory, UserInputSource } from "./types";

describe("scoring", () => {
  describe("emptyBaseline", () => {
    it("should return a baseline with all zeros", () => {
      const baseline = emptyBaseline();
      expect(baseline.count).toBe(0);
      expect(baseline.meanTokens).toBe(0);
      expect(baseline.meanErrors).toBe(0);
      expect(baseline.meanUserCorrections).toBe(0);
      expect(baseline.m2Tokens).toBe(0);
      expect(baseline.m2Errors).toBe(0);
      expect(baseline.m2UserCorrections).toBe(0);
    });
  });

  describe("updateBaseline", () => {
    it("should update count and means correctly", () => {
      let baseline = emptyBaseline();

      baseline = updateBaseline(baseline, 10000, 2, 1);
      expect(baseline.count).toBe(1);
      expect(baseline.meanTokens).toBe(10000);
      expect(baseline.meanErrors).toBe(2);
      expect(baseline.meanUserCorrections).toBe(1);

      baseline = updateBaseline(baseline, 8000, 1, 0);
      expect(baseline.count).toBe(2);
      expect(baseline.meanTokens).toBe(9000);
      expect(baseline.meanErrors).toBe(1.5);
      expect(baseline.meanUserCorrections).toBe(0.5);

      baseline = updateBaseline(baseline, 12000, 3, 2);
      expect(baseline.count).toBe(3);
      expect(baseline.meanTokens).toBeCloseTo(10000);
      expect(baseline.meanErrors).toBeCloseTo(2);
      expect(baseline.meanUserCorrections).toBeCloseTo(1);
    });

    it("should update m2 values correctly", () => {
      let baseline = emptyBaseline();

      baseline = updateBaseline(baseline, 10000, 2, 1);
      // m2 for first value is 0 (no variance)
      expect(baseline.m2Tokens).toBe(0);
      expect(baseline.m2Errors).toBe(0);
      expect(baseline.m2UserCorrections).toBe(0);

      baseline = updateBaseline(baseline, 10000, 2, 1);
      // m2 for second value is 0 (same as mean)
      expect(baseline.m2Tokens).toBe(0);
      expect(baseline.m2Errors).toBe(0);
      expect(baseline.m2UserCorrections).toBe(0);

      baseline = updateBaseline(baseline, 12000, 1, 0);
      // m2 for third value: (12000 - 10000) * (12000 - 10666.67) = 2000 * 1333.33 = 2666666.67
      expect(baseline.m2Tokens).toBeCloseTo(2666666.67);
    });
  });

  describe("computeTaskScore", () => {
    it("should use cold start heuristic for <10 tasks", () => {
      const baseline = updateBaseline(emptyBaseline(), 10000, 2, 1);

      // Same as baseline: userCorrections penalty of 0.5, completed signal of 1
      const score = computeTaskScore(baseline, 10000, 2, 1, true);
      expect(score).toBeCloseTo(0.5);

      // Better than baseline: lower tokens, fewer errors
      const better = computeTaskScore(baseline, 8000, 1, 0, true);
      expect(better).toBeGreaterThan(score);

      // Worse than baseline: more tokens, more errors
      const worse = computeTaskScore(baseline, 12000, 3, 2, true);
      expect(worse).toBeLessThan(score);
    });

    it("should use z-score for >=10 tasks", () => {
      // Build a baseline with 10 tasks
      let baseline = emptyBaseline();
      for (let i = 0; i < 10; i++) {
        baseline = updateBaseline(baseline, 10000, 2, 1);
      }

      // Same as baseline: score should be close to 1 (completed)
      const score = computeTaskScore(baseline, 10000, 2, 1, true);
      expect(score).toBeCloseTo(1);

      // Better than baseline: lower z-scores
      const better = computeTaskScore(baseline, 8000, 1, 0, true);
      expect(better).toBeGreaterThan(score);

      // Worse than baseline: higher z-scores
      const worse = computeTaskScore(baseline, 12000, 3, 2, true);
      expect(worse).toBeLessThan(score);
    });

    it("should penalize incomplete tasks", () => {
      let baseline = emptyBaseline();
      baseline = updateBaseline(baseline, 10000, 2, 1);

      const incomplete = computeTaskScore(baseline, 8000, 1, 0, false);
      const complete = computeTaskScore(baseline, 8000, 1, 0, true);
      expect(complete).toBeGreaterThan(incomplete);
    });

    it("should handle cold start with no prior baseline", () => {
      const baseline = emptyBaseline();

      // First task: no baseline to compare against, userCorrections penalty of 0.5, completed signal of 1
      const score = computeTaskScore(baseline, 10000, 2, 1, true);
      expect(score).toBeCloseTo(0.5);
    });

    it("should handle user corrections in cold start", () => {
      const baseline = emptyBaseline();

      const withCorrections = computeTaskScore(baseline, 8000, 1, 2, true);
      const withoutCorrections = computeTaskScore(baseline, 8000, 1, 0, true);
      expect(withoutCorrections).toBeGreaterThan(withCorrections);
    });
  });

  describe("computeCredit", () => {
    it("should calculate credit based on task score, self-report, and retrieval count", () => {
      // taskScore=3, selfReport=3, 1 retrieval = max credit
      const maxCredit = computeCredit(3, 3, 1);
      expect(maxCredit).toBeCloseTo(3);

      // taskScore=3, selfReport=3, 3 retrievals = diluted credit
      const dilutedCredit = computeCredit(3, 3, 3);
      expect(dilutedCredit).toBeCloseTo(1);

      // taskScore=0, selfReport=3, 1 retrieval = no credit
      const zeroCredit = computeCredit(0, 3, 1);
      expect(zeroCredit).toBeCloseTo(0);

      // taskScore=3, selfReport=0, 1 retrieval = no credit
      const zeroReport = computeCredit(3, 0, 1);
      expect(zeroReport).toBeCloseTo(0);
    });

    it("should handle negative task scores", () => {
      // taskScore=-2 (bad task), selfReport=3, 1 retrieval = negative credit
      const negativeCredit = computeCredit(-2, 3, 1);
      expect(negativeCredit).toBeCloseTo(-2);
    });

    it("should handle multiple retrievals", () => {
      const credit = computeCredit(3, 3, 5);
      expect(credit).toBeCloseTo(0.6);
    });
  });

  describe("updateWeight", () => {
    it("should update weight using EMA", () => {
      const oldWeight = 1.0;
      const credit = 1.0;
      const learningRate = 0.1;

      const newWeight = updateWeight(oldWeight, credit, learningRate);
      // (1 - 0.1) * 1.0 + 0.1 * 1.0 = 0.9 + 0.1 = 1.0
      expect(newWeight).toBeCloseTo(1.0);
    });

    it("should increase weight for positive credit", () => {
      const oldWeight = 1.0;
      const credit = 3.0;
      const learningRate = 0.1;

      const newWeight = updateWeight(oldWeight, credit, learningRate);
      // (1 - 0.1) * 1.0 + 0.1 * 3.0 = 0.9 + 0.3 = 1.2
      expect(newWeight).toBeCloseTo(1.2);
    });

    it("should decrease weight for negative credit", () => {
      const oldWeight = 1.0;
      const credit = -1.0;
      const learningRate = 0.1;

      const newWeight = updateWeight(oldWeight, credit, learningRate);
      // (1 - 0.1) * 1.0 + 0.1 * (-1.0) = 0.9 - 0.1 = 0.8
      expect(newWeight).toBeCloseTo(0.8);
    });

    it("should clamp weight to [0.1, 5.0]", () => {
      // Very negative credit should not go below 0.1
      const lowWeight = updateWeight(1.0, -100, 0.5);
      expect(lowWeight).toBeCloseTo(0.1);

      // Very positive credit should not go above 5.0
      const highWeight = updateWeight(1.0, 100, 0.5);
      expect(highWeight).toBeCloseTo(5.0);
    });

    it("should handle different learning rates", () => {
      const oldWeight = 1.0;
      const credit = 2.0;

      const fast = updateWeight(oldWeight, credit, 0.5);
      // (1 - 0.5) * 1.0 + 0.5 * 2.0 = 0.5 + 1.0 = 1.5
      expect(fast).toBeCloseTo(1.5);

      const slow = updateWeight(oldWeight, credit, 0.01);
      // (1 - 0.01) * 1.0 + 0.01 * 2.0 = 0.99 + 0.02 = 1.01
      expect(slow).toBeCloseTo(1.01);
    });
  });

  describe("initialWeight", () => {
    it("should return 1.0 for insight", () => {
      expect(initialWeight("insight")).toBe(1.0);
    });

    it("should return 1.0 for consolidated", () => {
      expect(initialWeight("consolidated")).toBe(1.0);
    });

    it("should return 1.0 for unknown categories", () => {
      expect(initialWeight("unknown" as MemoryCategory)).toBe(1.0);
    });

    it("should calculate correction weight based on cost", () => {
      // No cost: 1.0 + 0/10000 = 1.0
      expect(initialWeight("correction", undefined, undefined, 10000)).toBe(1.0);

      // Cost equal to avg: 1.0 + 10000/10000 = 2.0
      expect(initialWeight("correction", undefined, 10000, 10000)).toBe(2.0);

      // Cost double avg: 1.0 + 20000/10000 = 3.0
      expect(initialWeight("correction", undefined, 20000, 10000)).toBe(3.0);

      // Cost half avg: 1.0 + 5000/10000 = 1.5
      expect(initialWeight("correction", undefined, 5000, 10000)).toBe(1.5);
    });

    it("should use default avgTokens of 10000", () => {
      // No avgTokens provided: uses 10000
      expect(initialWeight("correction", undefined, 10000)).toBe(2.0);
    });

    it("should return correct user weights by source", () => {
      expect(initialWeight("user", "user_denial")).toBe(2.0);
      expect(initialWeight("user", "user_correction")).toBe(2.5);
      expect(initialWeight("user", "user_input")).toBe(2.0);
      expect(initialWeight("user", "unknown" as UserInputSource)).toBe(2.0);
    });
  });
});
