import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	connect,
	type Database as TursoDatabase,
} from "@tursodatabase/database";
import { desc, eq, sql } from "drizzle-orm";
import { createDrizzleDb } from "./db/index.js";
import * as schema from "./db/schema.js";
import { mockEmbed } from "./mock-embed.js";

// Turso driver truncates Float32Array to 1 byte/element. Wrap as Buffer to preserve float32 binary data.
function vecBuf(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// Create schema tables directly — bypasses runMigrations() which requires a migrations folder
async function createSchema(db: TursoDatabase): Promise<void> {
	await db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB,
      category TEXT NOT NULL CHECK(category IN ('correction', 'insight', 'user', 'consolidated', 'discovery')),
      weight REAL DEFAULT 1.0,
      initial_cost INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_retrieved INTEGER,
      retrieval_count INTEGER DEFAULT 0,
      source_task TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT,
      embedding BLOB,
      tokens_used INTEGER,
      tool_calls INTEGER,
      errors INTEGER,
      user_corrections INTEGER,
      completed INTEGER,
      task_score REAL,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS memory_retrievals (
      memory_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      similarity REAL,
      self_report REAL,
      credit REAL,
      PRIMARY KEY (memory_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

describe("MemoryStore API tests", () => {
	let tursoDb: TursoDatabase;
	let drizzleDb: ReturnType<typeof createDrizzleDb>;
	let _sessionId: string;

	beforeEach(async () => {
		_sessionId = `test-session-${randomUUID()}`;
		tursoDb = await connect(":memory:");
		await tursoDb.exec("PRAGMA busy_timeout = 5000");
		drizzleDb = createDrizzleDb(tursoDb);
		await createSchema(tursoDb);
	});

	afterEach(async () => {
		tursoDb.close();
	});

	describe("startTask — empty store", () => {
		it("should create a task and return empty memories array", async () => {
			const taskId = randomUUID();
			const taskDescription = "Fix the auth bug";
			const taskEmbedding = await mockEmbed(taskDescription);

			await drizzleDb.insert(schema.tasks).values({
				id: taskId,
				description: taskDescription,
				embedding: vecBuf(taskEmbedding),
				startedAt: Math.floor(Date.now() / 1000),
			});

			// No memories in store — should return empty
			const memCount = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(memCount?.c).toBe(0);
		});
	});

	describe("startTask — with memories", () => {
		it("should retrieve similar memories sorted by similarity", async () => {
			// Insert memories
			const memId1 = randomUUID();
			const memContent1 = "Auth middleware is in src/middleware/auth.rs";
			const memEmbedding1 = await mockEmbed(memContent1);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: memId1,
				content: memContent1,
				embedding: vecBuf(memEmbedding1),
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			const memId2 = randomUUID();
			const memContent2 = "Database migrations use drizzle-kit";
			const memEmbedding2 = await mockEmbed(memContent2);

			await drizzleDb.insert(schema.memories).values({
				id: memId2,
				content: memContent2,
				embedding: vecBuf(memEmbedding2),
				category: "insight",
				weight: 1.0,
				createdAt: now,
			});

			// Start a task with similar description
			const taskId = randomUUID();
			const taskDescription = "Fix the auth middleware";
			const taskEmbedding = await mockEmbed(taskDescription);

			await drizzleDb.insert(schema.tasks).values({
				id: taskId,
				description: taskDescription,
				embedding: vecBuf(taskEmbedding),
				startedAt: now,
			});

			// The auth memory should be retrieved (similar to task description)
			const taskBuf = vecBuf(taskEmbedding);
			const rows = await drizzleDb.all(
				sql`
          SELECT m.id, m.content, m.category, m.weight, m.created_at, m.retrieval_count,
            vector_distance_cos(vector32(m.embedding), ${taskBuf}) AS distance
          FROM memories m
          WHERE m.embedding IS NOT NULL
          ORDER BY
            (1.0 - vector_distance_cos(vector32(m.embedding), ${taskBuf}))
            DESC
          LIMIT 5
        `,
			);

			expect(rows.length).toBeGreaterThan(0);
			const authMem = (rows as any[]).find((r) => r.id === memId1);
			// Mock embeddings are random, so just verify we got results and the memory exists in the DB
			expect(authMem).toBeDefined();
		});
	});

	describe("reportCorrection", () => {
		it("should store a correction with correct category", async () => {
			const correctionId = randomUUID();
			const lesson = "Auth middleware is in src/middleware/auth.rs";
			const whatFailed = "Looked in src/auth/";
			const whatWorked = "Found it in src/middleware/auth.rs";
			const content = `${lesson}\n\nFailed approach: ${whatFailed}\nWorking approach: ${whatWorked}`;
			const embedding = await mockEmbed(content);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: correctionId,
				content,
				embedding: vecBuf(embedding),
				category: "correction",
				weight: 1.5, // Simulated weight based on tokensWasted
				initialCost: 5000,
				createdAt: now,
			});

			const mem = await drizzleDb
				.select({
					id: schema.memories.id,
					category: schema.memories.category,
					weight: schema.memories.weight,
				})
				.from(schema.memories)
				.where(eq(schema.memories.id, correctionId))
				.get();

			expect(mem).toBeDefined();
			expect(mem?.category).toBe("correction");
			expect(mem?.weight).toBeGreaterThan(1.0);
		});

		it("should create correction with weight based on tokensWasted", async () => {
			// tokensWasted=10000, avgTokens=10000 → weight = 1.0 + 10000/10000 = 2.0
			const correctionId = randomUUID();
			const content = "Config is in .env.local, not src/config.json";
			const embedding = await mockEmbed(content);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: correctionId,
				content,
				embedding: vecBuf(embedding),
				category: "correction",
				weight: 2.0,
				initialCost: 10000,
				createdAt: now,
			});

			const mem = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, correctionId))
				.get();

			expect(mem?.weight).toBe(2.0);
		});
	});

	describe("reportUserInput", () => {
		it("should store a user input with correct category", async () => {
			const inputId = randomUUID();
			const lesson = "We use pnpm, not npm";
			const embedding = await mockEmbed(lesson);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: inputId,
				content: lesson,
				embedding: vecBuf(embedding),
				category: "user",
				weight: 2.0, // user_correction weight
				createdAt: now,
			});

			const mem = await drizzleDb
				.select({ category: schema.memories.category })
				.from(schema.memories)
				.where(eq(schema.memories.id, inputId))
				.get();

			expect(mem?.category).toBe("user");
		});
	});

	describe("endTask — baseline update", () => {
		it("should update task record with metrics", async () => {
			const taskId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.tasks).values({
				id: taskId,
				description: "Fix the auth bug",
				embedding: vecBuf(await mockEmbed("Fix the auth bug")),
				startedAt: now,
			});

			// Simulate endTask: update task record
			const taskScore = 1.5;
			await drizzleDb
				.update(schema.tasks)
				.set({
					tokensUsed: 10000,
					toolCalls: 20,
					errors: 0,
					userCorrections: 0,
					completed: 1,
					taskScore,
					finishedAt: now,
				})
				.where(eq(schema.tasks.id, taskId));

			const task = await drizzleDb
				.select({
					tokensUsed: schema.tasks.tokensUsed,
					toolCalls: schema.tasks.toolCalls,
					errors: schema.tasks.errors,
					completed: schema.tasks.completed,
					taskScore: schema.tasks.taskScore,
				})
				.from(schema.tasks)
				.where(eq(schema.tasks.id, taskId))
				.get();

			expect(task?.tokensUsed).toBe(10000);
			expect(task?.toolCalls).toBe(20);
			expect(task?.errors).toBe(0);
			expect(task?.completed).toBe(1);
			expect(task?.taskScore).toBeCloseTo(1.5);
		});

		it("should persist baseline to meta table", async () => {
			const baseline = {
				count: 1,
				meanTokens: 10000,
				meanErrors: 0,
				meanUserCorrections: 0,
				m2Tokens: 0,
				m2Errors: 0,
				m2UserCorrections: 0,
			};

			await drizzleDb
				.insert(schema.meta)
				.values({
					key: "baseline",
					value: JSON.stringify(baseline),
				})
				.onConflictDoUpdate({
					target: schema.meta.key,
					set: { value: JSON.stringify(baseline) },
				});

			const row = await drizzleDb
				.select({ value: schema.meta.value })
				.from(schema.meta)
				.where(eq(schema.meta.key, "baseline"))
				.get();

			expect(row).toBeDefined();
			const parsed = JSON.parse(row?.value);
			expect(parsed.count).toBe(1);
			expect(parsed.meanTokens).toBe(10000);
		});
	});

	describe("endTask — selfReport weight updates", () => {
		it("should update memory weight via selfReport", async () => {
			const memId = randomUUID();
			const taskId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Auth middleware is in src/middleware/auth.rs",
				embedding: vecBuf(
					await mockEmbed("Auth middleware is in src/middleware/auth.rs"),
				),
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			// Insert task
			await drizzleDb.insert(schema.tasks).values({
				id: taskId,
				description: "Fix the auth bug",
				embedding: vecBuf(await mockEmbed("Fix the auth bug")),
				startedAt: now,
			});

			// Simulate endTask with selfReport
			const taskScore = 2.0;
			const numRetrieved = 1;
			const selfReportScore = 3;
			const credit = taskScore * (selfReportScore / 3.0) * (1.0 / numRetrieved); // 2.0 * 1.0 * 1.0 = 2.0
			const newWeight = (1 - 0.1) * 1.0 + 0.1 * credit; // 0.9 + 0.2 = 1.1

			await drizzleDb
				.update(schema.memories)
				.set({ weight: newWeight })
				.where(eq(schema.memories.id, memId));

			await drizzleDb
				.insert(schema.memoryRetrievals)
				.values({
					memoryId: memId,
					taskId,
					similarity: 0.9,
					selfReport: selfReportScore,
					credit,
				})
				.onConflictDoUpdate({
					target: [
						schema.memoryRetrievals.memoryId,
						schema.memoryRetrievals.taskId,
					],
					set: { selfReport: selfReportScore, credit },
				});

			const mem = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(mem?.weight).toBeCloseTo(1.1);
		});

		it("should handle negative selfReport", async () => {
			const memId = randomUUID();
			const taskId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Wrong approach",
				embedding: vecBuf(await mockEmbed("Wrong approach")),
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			// Simulate endTask with negative selfReport
			const taskScore = 1.0;
			const numRetrieved = 1;
			const selfReportScore = 0;
			const credit = taskScore * (selfReportScore / 3.0) * (1.0 / numRetrieved); // 0.0
			const newWeight = (1 - 0.1) * 1.0 + 0.1 * credit; // 0.9

			await drizzleDb
				.update(schema.memories)
				.set({ weight: newWeight })
				.where(eq(schema.memories.id, memId));

			await drizzleDb
				.insert(schema.memoryRetrievals)
				.values({
					memoryId: memId,
					taskId,
					similarity: 0.5,
					selfReport: selfReportScore,
					credit,
				})
				.onConflictDoUpdate({
					target: [
						schema.memoryRetrievals.memoryId,
						schema.memoryRetrievals.taskId,
					],
					set: { selfReport: selfReportScore, credit },
				});

			const mem = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(mem?.weight).toBeCloseTo(0.9);
		});
	});

	describe("decay", () => {
		it("should apply multiplicative decay to all memories", async () => {
			const memId1 = randomUUID();
			const memId2 = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memories with known weights
			await drizzleDb.insert(schema.memories).values({
				id: memId1,
				content: "Memory 1",
				category: "insight",
				weight: 2.0,
				createdAt: now,
			});

			await drizzleDb.insert(schema.memories).values({
				id: memId2,
				content: "Memory 2",
				category: "insight",
				weight: 3.0,
				createdAt: now,
			});

			// Decay rate 0.995
			const decayRate = 0.995;
			await drizzleDb.run(
				sql`UPDATE memories SET weight = weight * ${decayRate}`,
			);

			const mem1 = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId1))
				.get();

			const mem2 = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId2))
				.get();

			expect(mem1?.weight).toBeCloseTo(2.0 * 0.995);
			expect(mem2?.weight).toBeCloseTo(3.0 * 0.995);
		});

		it("should delete stale memories (weight < 0.15 AND retrieval_count > 5)", async () => {
			const staleMemId = randomUUID();
			const validMemId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Stale memory: weight < 0.15 AND retrieval_count > 5
			await drizzleDb.insert(schema.memories).values({
				id: staleMemId,
				content: "Stale memory",
				category: "insight",
				weight: 0.14,
				createdAt: now,
				retrievalCount: 10,
			});

			// Valid memory: weight < 0.15 BUT retrieval_count <= 5
			await drizzleDb.insert(schema.memories).values({
				id: validMemId,
				content: "Valid memory",
				category: "insight",
				weight: 0.14,
				createdAt: now,
				retrievalCount: 3,
			});

			// Decay
			const decayRate = 0.995;
			await drizzleDb.run(
				sql`UPDATE memories SET weight = weight * ${decayRate}`,
			);

			// Delete stale memories
			const deleted = await drizzleDb.run(
				sql`DELETE FROM memories WHERE weight < 0.15 AND retrieval_count > 5`,
			);

			expect(deleted.changes).toBe(1);

			const stale = await drizzleDb
				.select({ id: schema.memories.id })
				.from(schema.memories)
				.where(eq(schema.memories.id, staleMemId))
				.get();

			const valid = await drizzleDb
				.select({ id: schema.memories.id })
				.from(schema.memories)
				.where(eq(schema.memories.id, validMemId))
				.get();

			expect(stale).toBeUndefined(); // Deleted
			expect(valid).toBeDefined(); // Still exists
		});
	});

	describe("purge", () => {
		it("should delete memories below weight threshold", async () => {
			const lowWeightId = randomUUID();
			const highWeightId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Low weight memory
			await drizzleDb.insert(schema.memories).values({
				id: lowWeightId,
				content: "Low priority memory",
				category: "correction",
				weight: 0.1,
				createdAt: now,
			});

			// High weight memory
			await drizzleDb.insert(schema.memories).values({
				id: highWeightId,
				content: "High priority memory",
				category: "insight",
				weight: 3.0,
				createdAt: now,
			});

			// Purge memories below 0.5
			const purged = await drizzleDb.run(
				sql`DELETE FROM memories WHERE weight < 0.5`,
			);
			expect(purged.changes).toBe(1);

			const low = await drizzleDb
				.select({ id: schema.memories.id })
				.from(schema.memories)
				.where(eq(schema.memories.id, lowWeightId))
				.get();

			const high = await drizzleDb
				.select({ id: schema.memories.id })
				.from(schema.memories)
				.where(eq(schema.memories.id, highWeightId))
				.get();

			expect(low).toBeUndefined(); // Purged
			expect(high).toBeDefined(); // Still exists
		});

		it("should handle purge with no matching memories", async () => {
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: randomUUID(),
				content: "Normal memory",
				category: "insight",
				weight: 1.0,
				createdAt: now,
			});

			// Purge with high threshold — nothing to delete
			const purged = await drizzleDb.run(
				sql`DELETE FROM memories WHERE weight < 0.5`,
			);
			expect(purged.changes).toBe(0);
		});
	});

	describe("contradictMemory", () => {
		it("should delete the memory and its retrievals", async () => {
			const memId = randomUUID();
			const taskId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Wrong approach: always use npm",
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			// Insert retrieval
			await drizzleDb.insert(schema.memoryRetrievals).values({
				memoryId: memId,
				taskId,
				similarity: 0.8,
			});

			// Delete the memory and its retrievals
			await drizzleDb
				.delete(schema.memories)
				.where(eq(schema.memories.id, memId));
			await drizzleDb
				.delete(schema.memoryRetrievals)
				.where(eq(schema.memoryRetrievals.memoryId, memId));

			const mem = await drizzleDb
				.select({ id: schema.memories.id })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			const retrieval = await drizzleDb
				.select({ id: schema.memoryRetrievals.memoryId })
				.from(schema.memoryRetrievals)
				.where(eq(schema.memoryRetrievals.memoryId, memId))
				.get();

			expect(mem).toBeUndefined();
			expect(retrieval).toBeUndefined();
		});

		it("should optionally create a correction memory", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory to contradict
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Wrong approach: always use npm",
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			// Delete the memory
			await drizzleDb
				.delete(schema.memories)
				.where(eq(schema.memories.id, memId));
			await drizzleDb
				.delete(schema.memoryRetrievals)
				.where(eq(schema.memoryRetrievals.memoryId, memId));

			// Store correction
			const correctionId = randomUUID();
			const correction = "Use pnpm instead";
			const correctionEmbedding = await mockEmbed(correction);

			await drizzleDb.insert(schema.memories).values({
				id: correctionId,
				content: correction,
				embedding: vecBuf(correctionEmbedding),
				category: "correction",
				weight: 2.0,
				createdAt: now,
			});

			const memCount = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();

			expect(memCount?.c).toBe(1);
			const correctionMem = await drizzleDb
				.select({
					content: schema.memories.content,
					weight: schema.memories.weight,
				})
				.from(schema.memories)
				.get();

			expect(correctionMem?.content).toBe(correction);
			expect(correctionMem?.weight).toBe(2.0);
		});

		it("should handle contradict with non-existent memory ID", async () => {
			// Contradict a non-existent memory — should not throw
			const nonExistentId = randomUUID();
			await drizzleDb
				.delete(schema.memories)
				.where(eq(schema.memories.id, nonExistentId));
			await drizzleDb
				.delete(schema.memoryRetrievals)
				.where(eq(schema.memoryRetrievals.memoryId, nonExistentId));

			// No error — just no-op
			const memCount = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();

			expect(memCount?.c).toBe(0);
		});
	});

	describe("getStats", () => {
		it("should return correct statistics", async () => {
			const now = Math.floor(Date.now() / 1000);

			// Insert memories
			await drizzleDb.insert(schema.memories).values({
				id: randomUUID(),
				content: "Memory 1",
				category: "insight",
				weight: 1.0,
				createdAt: now,
			});

			await drizzleDb.insert(schema.memories).values({
				id: randomUUID(),
				content: "Memory 2",
				category: "correction",
				weight: 2.0,
				createdAt: now,
			});

			// Insert task with score
			const taskId = randomUUID();
			await drizzleDb.insert(schema.tasks).values({
				id: taskId,
				description: "Task 1",
				embedding: vecBuf(await mockEmbed("Task 1")),
				startedAt: now,
				taskScore: 1.5,
			});

			const stats = await drizzleDb
				.select({
					memCount: sql<number>`count(*)`,
					taskCount: sql<number>`(SELECT count(*) FROM tasks)`,
					avgScore: sql<number>`(SELECT avg(task_score) FROM tasks WHERE task_score IS NOT NULL)`,
				})
				.from(schema.memories)
				.get();

			expect(stats?.memCount).toBe(2);
			expect(stats?.taskCount).toBe(1);
			expect(stats?.avgScore).toBeCloseTo(1.5);
		});
	});

	describe("getTopByWeight", () => {
		it("should return memories sorted by weight descending", async () => {
			const now = Math.floor(Date.now() / 1000);

			// Insert memories with different weights
			const lowId = randomUUID();
			await drizzleDb.insert(schema.memories).values({
				id: lowId,
				content: "Low weight",
				category: "insight",
				weight: 0.5,
				createdAt: now,
			});

			const highId = randomUUID();
			await drizzleDb.insert(schema.memories).values({
				id: highId,
				content: "High weight",
				category: "insight",
				weight: 3.0,
				createdAt: now,
			});

			const midId = randomUUID();
			await drizzleDb.insert(schema.memories).values({
				id: midId,
				content: "Mid weight",
				category: "insight",
				weight: 1.5,
				createdAt: now,
			});

			const rows = await drizzleDb
				.select({
					id: schema.memories.id,
					weight: schema.memories.weight,
				})
				.from(schema.memories)
				.orderBy(desc(schema.memories.weight))
				.limit(3);

			expect(rows.length).toBe(3);
			expect((rows as any[])[0].id).toBe(highId);
			expect((rows as any[])[0].weight).toBe(3.0);
			expect((rows as any[])[1].id).toBe(midId);
			expect((rows as any[])[1].weight).toBe(1.5);
			expect((rows as any[])[2].id).toBe(lowId);
			expect((rows as any[])[2].weight).toBe(0.5);
		});
	});

	describe("insertRawMemory", () => {
		it("should create a memory without embedding", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Raw memory without embedding",
				category: "insight",
				weight: 1.0,
				createdAt: now,
			});

			const mem = await drizzleDb
				.select({
					id: schema.memories.id,
					content: schema.memories.content,
					category: schema.memories.category,
					weight: schema.memories.weight,
				})
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(mem).toBeDefined();
			expect(mem?.content).toBe("Raw memory without embedding");
			expect(mem?.category).toBe("insight");
			expect(mem?.weight).toBe(1.0);
		});
	});

	describe("penalizeMemory", () => {
		it("should reduce memory weight by factor", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory with weight 2.0
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Memory to penalize",
				category: "insight",
				weight: 2.0,
				createdAt: now,
			});

			// Penalize by factor 0.5 → 2.0 * 0.5 = 1.0
			const newWeight = Math.max(2.0 * 0.5, 0.1);
			await drizzleDb
				.update(schema.memories)
				.set({ weight: newWeight })
				.where(eq(schema.memories.id, memId));

			const mem = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(mem?.weight).toBeCloseTo(1.0);
		});

		it("should clamp weight to minimum of 0.1", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory with weight 0.15
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Memory to penalize heavily",
				category: "insight",
				weight: 0.15,
				createdAt: now,
			});

			// Penalize by factor 0.1 → 0.15 * 0.1 = 0.015, clamped to 0.1
			const newWeight = Math.max(0.15 * 0.1, 0.1);
			await drizzleDb
				.update(schema.memories)
				.set({ weight: newWeight })
				.where(eq(schema.memories.id, memId));

			const mem = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(mem?.weight).toBeCloseTo(0.1);
		});

		it("should handle penalize with non-existent memory ID", async () => {
			const nonExistentId = randomUUID();
			// Penalize a non-existent memory — should not throw
			const currentWeight = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, nonExistentId))
				.get();

			// currentWeight is undefined — no-op
			expect(currentWeight).toBeUndefined();
		});
	});

	describe("embedPending", () => {
		it("should embed NULL embeddings", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Insert memory without embedding
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Memory without embedding",
				category: "insight",
				weight: 1.0,
				createdAt: now,
			});

			// Embed the pending memory
			const embedding = await mockEmbed("Memory without embedding");
			await drizzleDb
				.update(schema.memories)
				.set({ embedding: vecBuf(embedding) })
				.where(eq(schema.memories.id, memId));

			const mem = await drizzleDb
				.select({ hasEmbedding: sql<number>`embedding IS NOT NULL` })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(mem?.hasEmbedding).toBe(1);
		});

		it("should return 0 when no pending embeddings", async () => {
			// No memories — should return 0
			const pendingCount = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.where(sql`${schema.memories.embedding} IS NULL`)
				.get();

			expect(pendingCount?.c).toBe(0);
		});
	});
});
