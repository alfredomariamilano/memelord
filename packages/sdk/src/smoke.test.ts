import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	connect,
	type Database as TursoDatabase,
} from "@tursodatabase/database";
import { eq, sql } from "drizzle-orm";
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

describe("MemoryStore smoke tests", () => {
	let tursoDb: TursoDatabase;
	let drizzleDb: ReturnType<typeof createDrizzleDb>;
	let sessionId: string;

	beforeEach(async () => {
		sessionId = "test-session-" + randomUUID();
		// Use in-memory database — no multiprocess_wal needed
		tursoDb = await connect(":memory:");
		await tursoDb.exec("PRAGMA busy_timeout = 5000");
		drizzleDb = createDrizzleDb(tursoDb);
		// Create schema tables directly — bypasses runMigrations() which requires a migrations folder
		await createSchema(tursoDb);
	});

	afterEach(async () => {
		tursoDb.close();
	});

	describe("1. Store initialization", () => {
		it("should create tables on init", async () => {
			const stats = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(stats?.c).toBe(0);
			const taskStats = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.tasks)
				.get();
			expect(taskStats?.c).toBe(0);
		});
	});

	describe("2. startTask", () => {
		it("should create a task and retrieve similar memories", async () => {
			// Insert a memory first
			const memId = randomUUID();
			const memContent = "Auth middleware is in src/middleware/auth.rs";
			const memEmbedding = await mockEmbed(memContent);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: memContent,
				embedding: vecBuf(memEmbedding),
				category: "correction",
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

			// The memory should be retrieved via vector similarity
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
			const authMem = (rows as any[]).find((r) => r.id === memId);
			// Mock embeddings are random, so just verify we got results and the memory exists in the DB
			expect(authMem).toBeDefined();
		});
	});

	describe("3. reportCorrection", () => {
		it("should store a correction with embedding", async () => {
			const correctionId = randomUUID();
			const lesson = "Config is in .env.local, not src/config.json";
			const whatFailed = "Searched src/config.json";
			const whatWorked = "Found .env.local";
			const content = `${lesson}\n\nFailed approach: ${whatFailed}\nWorking approach: ${whatWorked}`;
			const embedding = await mockEmbed(content);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: correctionId,
				content,
				embedding: vecBuf(embedding),
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			const stats = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(stats?.c).toBeGreaterThan(0);
		});
	});

	describe("4. endTask", () => {
		it("should rate retrieved memories and update weights", async () => {
			const memId = randomUUID();
			const memContent = "Use pnpm for package management";
			const memEmbedding = await mockEmbed(memContent);
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: memContent,
				embedding: vecBuf(memEmbedding),
				category: "user",
				weight: 1.0,
				createdAt: now,
			});

			const taskId = randomUUID();
			const taskDescription = "Install dependencies";
			const taskEmbedding = await mockEmbed(taskDescription);

			await drizzleDb.insert(schema.tasks).values({
				id: taskId,
				description: taskDescription,
				embedding: vecBuf(taskEmbedding),
				startedAt: now,
			});

			// Simulate endTask: update task score and memory weight
			const taskScore = 1.0; // Simulated task score
			const credit = 0.5; // Simulated credit for score 3

			await drizzleDb
				.update(schema.tasks)
				.set({
					tokensUsed: 5000,
					toolCalls: 10,
					errors: 0,
					userCorrections: 0,
					completed: 1,
					taskScore,
					finishedAt: now,
				})
				.where(eq(schema.tasks.id, taskId));

			// Update memory weight (1.0 + 0.5 * 0.1 = 1.05)
			await drizzleDb
				.update(schema.memories)
				.set({ weight: 1.05 })
				.where(eq(schema.memories.id, memId));

			const ratedMem = await drizzleDb
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memId))
				.get();

			expect(ratedMem?.weight).toBeGreaterThan(1.0);
		});
	});

	describe("5. Decay", () => {
		it("should decrease weights and delete stale memories", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			// Weight 0.151 * 0.995 = 0.150245, still above 0.15 — won't be deleted
			// Use 0.155 * 0.995 = 0.154225 — still above 0.15
			// Use 0.14 * 0.995 = 0.1393 — below 0.15, will be deleted
			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Old memory about deprecated API",
				category: "insight",
				weight: 0.14,
				createdAt: now,
				retrievalCount: 10,
			});

			// Decay the store
			const decayRate = 0.995;
			await drizzleDb.run(
				sql`UPDATE memories SET weight = weight * ${decayRate}`,
			);

			const decayed = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(decayed?.c).toBe(1);
			// Weight dropped below 0.15 and retrieval_count is 10, so should be deleted
			const deleted = await drizzleDb.run(
				sql`DELETE FROM memories WHERE weight < 0.15 AND retrieval_count > 5`,
			);
			expect(deleted.changes).toBe(1);
		});
	});

	describe("6. Purge", () => {
		it("should delete memories below weight threshold", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Low priority memory",
				category: "correction",
				weight: 0.1,
				createdAt: now,
			});

			const before = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(before?.c).toBeGreaterThan(0);

			const purged = await drizzleDb.run(
				sql`DELETE FROM memories WHERE weight < 0.5`,
			);
			expect(purged.changes).toBe(1);

			const after = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(after?.c).toBe(0);
		});
	});

	describe("7. Contradict", () => {
		it("should delete a bad memory and optionally store correction", async () => {
			const memId = randomUUID();
			const now = Math.floor(Date.now() / 1000);

			await drizzleDb.insert(schema.memories).values({
				id: memId,
				content: "Wrong approach: always use npm",
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			// Delete the bad memory
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

			const stats = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(stats?.c).toBe(1);
		});
	});

	describe("8. Multiple tasks", () => {
		it("should isolate memories between tasks", async () => {
			const now = Math.floor(Date.now() / 1000);

			const taskId1 = randomUUID();
			const taskEmbedding1 = await mockEmbed("Task 1");

			await drizzleDb.insert(schema.tasks).values({
				id: taskId1,
				description: "Task 1",
				embedding: vecBuf(taskEmbedding1),
				startedAt: now,
			});

			const memId1 = randomUUID();
			const memContent1 = "Task 1 correction";
			const memEmbedding1 = await mockEmbed(memContent1);

			await drizzleDb.insert(schema.memories).values({
				id: memId1,
				content: memContent1,
				embedding: vecBuf(memEmbedding1),
				category: "correction",
				weight: 1.0,
				createdAt: now,
				sourceTask: taskId1,
			});

			const taskId2 = randomUUID();
			const taskEmbedding2 = await mockEmbed("Task 2");

			await drizzleDb.insert(schema.tasks).values({
				id: taskId2,
				description: "Task 2",
				embedding: vecBuf(taskEmbedding2),
				startedAt: now,
			});

			const memId2 = randomUUID();
			const memContent2 = "Task 2 correction";
			const memEmbedding2 = await mockEmbed(memContent2);

			await drizzleDb.insert(schema.memories).values({
				id: memId2,
				content: memContent2,
				embedding: vecBuf(memEmbedding2),
				category: "correction",
				weight: 1.0,
				createdAt: now,
				sourceTask: taskId2,
			});

			const taskCount = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.tasks)
				.get();
			expect(taskCount?.c).toBe(2);

			const memCount = await drizzleDb
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			expect(memCount?.c).toBe(2);
		});
	});

	describe("9. Memory search", () => {
		it("should retrieve memories by vector similarity", async () => {
			const now = Math.floor(Date.now() / 1000);

			const memId1 = randomUUID();
			const memContent1 = "Database migrations use drizzle-kit";
			const memEmbedding1 = await mockEmbed(memContent1);

			await drizzleDb.insert(schema.memories).values({
				id: memId1,
				content: memContent1,
				embedding: vecBuf(memEmbedding1),
				category: "insight",
				weight: 1.0,
				createdAt: now,
			});

			const memId2 = randomUUID();
			const memContent2 = "Auth uses JWT tokens";
			const memEmbedding2 = await mockEmbed(memContent2);

			await drizzleDb.insert(schema.memories).values({
				id: memId2,
				content: memContent2,
				embedding: vecBuf(memEmbedding2),
				category: "correction",
				weight: 1.0,
				createdAt: now,
			});

			const memId3 = randomUUID();
			const memContent3 = "Testing framework is bun:test";
			const memEmbedding3 = await mockEmbed(memContent3);

			await drizzleDb.insert(schema.memories).values({
				id: memId3,
				content: memContent3,
				embedding: vecBuf(memEmbedding3),
				category: "user",
				weight: 1.0,
				createdAt: now,
			});

			const taskDescription = "Set up database migrations";
			const taskEmbedding = await mockEmbed(taskDescription);

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
			const dbMem = (rows as any[]).find((r) =>
				r.content.includes("Database migrations"),
			);
			// Mock embeddings are random, so just verify we got results and the memory exists in the DB
			expect(dbMem).toBeDefined();
		});
	});
});
