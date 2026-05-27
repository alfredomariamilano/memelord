import { randomUUID } from "node:crypto";
import {
	connect,
	type Database as TursoDatabase,
} from "@tursodatabase/database";
import { desc, eq, sql } from "drizzle-orm";
import { createDrizzleDb, runMigrations } from "./db/index";
import * as schema from "./db/schema";
import {
	computeCredit,
	computeTaskScore,
	emptyBaseline,
	initialWeight,
	updateBaseline,
	updateWeight,
} from "./scoring";
import type {
	DecayResult,
	MemelordConfig,
	Memory,
	MemoryCategory,
	MemoryStats,
	ReportCorrectionInput,
	ReportUserInput,
	StartTaskResult,
	TaskBaseline,
	TaskEndInput,
	VectorType,
} from "./types";

/** Turso driver truncates Float32Array to 1 byte/element. Wrap as Buffer to preserve float32 binary data. */
function vecBuf(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

type DrizzleDb = ReturnType<typeof createDrizzleDb>;

interface RawVectorRow {
	id: string;
	content: string;
	category: MemoryCategory;
	weight: number;
	created_at: number;
	retrieval_count: number;
	distance: number;
}

export class MemoryStore {
	private initialized = false;
	private currentTaskId: string | null = null;
	private baseline: TaskBaseline = emptyBaseline();

	private readonly dbPath: string;
	private readonly sessionId: string;
	private readonly embed: MemelordConfig["embed"];
	private readonly vectorType: VectorType;
	private readonly topK: number;
	private readonly learningRate: number;
	private readonly decayRate: number;

	constructor(config: MemelordConfig) {
		this.dbPath = config.dbPath;
		this.sessionId = config.sessionId;
		this.embed = config.embed;
		this.vectorType = config.vectorType ?? "vector32";
		this.topK = config.topK ?? 5;
		this.learningRate = config.learningRate ?? 0.1;
		this.decayRate = config.decayRate ?? 0.995;
	}

	private async withDb<T>(fn: (db: DrizzleDb) => Promise<T>): Promise<T> {
		const maxRetries = 10;
		const baseDelay = 50; // ms

		let db: TursoDatabase;
		for (let attempt = 0; ; attempt++) {
			try {
				db = await connect(this.dbPath, {
					experimental: ["multiprocess_wal"],
				});
				break;
			} catch (e: any) {
				if (
					attempt >= maxRetries ||
					(!e.message?.includes("locked") && !e.message?.includes("Locking"))
				) {
					throw e;
				}
				const delay =
					baseDelay * (1 + Math.random()) * Math.min(attempt + 1, 5);
				await new Promise((r) => setTimeout(r, delay));
			}
		}

		await db.exec("PRAGMA busy_timeout = 5000");
		const drizzleDb = createDrizzleDb(db);
		try {
			return await fn(drizzleDb);
		} finally {
			db.close();
		}
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await this.withDb(async (db) => {
			// Run schema migrations (creates tables if they don't exist)
			await runMigrations(db);

			// One-time migration: detect embeddings truncated by Float32Array driver bug
			const result = await db.run(
				sql`UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL AND length(embedding) < 1536`,
			);
			if (result.changes > 0) {
				console.error(
					`[memelord] Fixed ${result.changes} truncated embeddings (will re-embed on next startTask)`,
				);
			}

			const row = await db
				.select({ value: schema.meta.value })
				.from(schema.meta)
				.where(eq(schema.meta.key, "baseline"))
				.get();
			if (row) {
				this.baseline = JSON.parse(row.value);
			}
		});
		this.initialized = true;
	}

	private get vfn(): string {
		return this.vectorType;
	}

	async startTask(description: string): Promise<StartTaskResult> {
		await this.init();
		const taskId = randomUUID();
		const now = Math.floor(Date.now() / 1000);

		const taskEmbedding = await this.embed(description);

		await this.embedPending();

		const memories = await this.withDb(async (db) => {
			await db.insert(schema.tasks).values({
				id: taskId,
				description,
				embedding: vecBuf(taskEmbedding),
				startedAt: now,
			});

			const vfn = this.vfn;
			const rows = await db.all(
				sql`
        SELECT
          m.id, m.content, m.category, m.weight, m.created_at, m.retrieval_count,
          vector_distance_cos(${vfn}(m.embedding), ${vfn}(vecBuf(taskEmbedding))) AS distance
        FROM memories m
        WHERE m.embedding IS NOT NULL
        ORDER BY
          (1.0 - vector_distance_cos(${vfn}(m.embedding), ${vfn}(vecBuf(taskEmbedding))))
          * POWER(${this.decayRate}, (${now} - COALESCE(m.last_retrieved, m.created_at)) / 86400.0)
        DESC
        LIMIT ${this.topK}
      `,
			);

			const mems: Memory[] = (rows as RawVectorRow[]).map((r) => ({
				id: r.id,
				content: r.content,
				category: r.category as MemoryCategory,
				weight: r.weight ?? 1.0,
				score: 1.0 - r.distance,
				createdAt: r.created_at,
				retrievalCount: r.retrieval_count,
			}));

			for (const mem of mems) {
				await db
					.insert(schema.memoryRetrievals)
					.values({
						memoryId: mem.id,
						taskId,
						similarity: mem.score,
					})
					.onConflictDoNothing();

				await db
					.update(schema.memories)
					.set({ lastRetrieved: now })
					.where(eq(schema.memories.id, mem.id));
			}

			return mems;
		});

		this.currentTaskId = taskId;
		return { taskId, memories };
	}

	async reportCorrection(input: ReportCorrectionInput): Promise<string> {
		await this.init();
		const id = randomUUID();
		const now = Math.floor(Date.now() / 1000);

		const content = `${input.lesson}\n\nFailed approach: ${input.whatFailed}\nWorking approach: ${input.whatWorked}`;
		const embedding = await this.embed(content);

		await this.withDb(async (db) => {
			const avgRow = await db
				.select({ avg: schema.tasks.tokensUsed })
				.from(schema.tasks)
				.where(sql`${schema.tasks.tokensUsed} IS NOT NULL`)
				.get();
			const avgTokens = avgRow?.avg ?? 10000;

			const weight = initialWeight(
				"correction",
				undefined,
				input.tokensWasted,
				avgTokens,
			);

			await db.insert(schema.memories).values({
				id,
				content,
				embedding: vecBuf(embedding),
				category: "correction",
				weight,
				initialCost: input.tokensWasted ?? 0,
				createdAt: now,
				sourceTask: this.currentTaskId,
			});
		});

		return id;
	}

	async reportUserInput(input: ReportUserInput): Promise<string> {
		await this.init();
		const id = randomUUID();
		const now = Math.floor(Date.now() / 1000);

		const embedding = await this.embed(input.lesson);
		const weight = initialWeight("user", input.source);

		await this.withDb(async (db) => {
			await db.insert(schema.memories).values({
				id,
				content: input.lesson,
				embedding: vecBuf(embedding),
				category: "user" as MemoryCategory,
				weight,
				createdAt: now,
				sourceTask: this.currentTaskId,
			});
		});

		return id;
	}

	async endTask(taskId: string, input: TaskEndInput): Promise<void> {
		await this.init();
		const now = Math.floor(Date.now() / 1000);

		const taskScore = computeTaskScore(
			this.baseline,
			input.tokensUsed,
			input.errors,
			input.userCorrections,
			input.completed,
		);

		this.baseline = updateBaseline(
			this.baseline,
			input.tokensUsed,
			input.errors,
			input.userCorrections,
		);

		await this.withDb(async (db) => {
			await db
				.update(schema.tasks)
				.set({
					tokensUsed: input.tokensUsed,
					toolCalls: input.toolCalls,
					errors: input.errors,
					userCorrections: input.userCorrections,
					completed: input.completed ? 1 : 0,
					taskScore,
					finishedAt: now,
				})
				.where(eq(schema.tasks.id, taskId));

			await db
				.insert(schema.meta)
				.values({
					key: "baseline",
					value: JSON.stringify(this.baseline),
				})
				.onConflictDoUpdate({
					target: schema.meta.key,
					set: { value: JSON.stringify(this.baseline) },
				});

			if (input.selfReport && input.selfReport.length > 0) {
				const numRetrieved = input.selfReport.length;

				for (const entry of input.selfReport) {
					const credit = computeCredit(taskScore, entry.score, numRetrieved);

					const memRow = await db
						.select({ weight: schema.memories.weight })
						.from(schema.memories)
						.where(eq(schema.memories.id, entry.memoryId))
						.get();

					if (memRow) {
						const newWeight = updateWeight(
							memRow.weight ?? 1.0,
							credit,
							this.learningRate,
						);
						await db
							.update(schema.memories)
							.set({ weight: newWeight })
							.where(eq(schema.memories.id, entry.memoryId));
					}

					await db
						.update(schema.memoryRetrievals)
						.set({ selfReport: entry.score, credit })
						.where(
							sql`${schema.memoryRetrievals.memoryId} = ${entry.memoryId} AND ${schema.memoryRetrievals.taskId} = ${taskId}`,
						);
				}
			}
		});

		if (this.currentTaskId === taskId) {
			this.currentTaskId = null;
		}
	}

	async decay(): Promise<DecayResult> {
		await this.init();
		return this.withDb(async (db) => {
			const result1 = await db.run(
				sql`UPDATE memories SET weight = weight * ${this.decayRate}`,
			);
			const result2 = await db.run(
				sql`DELETE FROM memories WHERE weight < 0.15 AND retrieval_count > 5`,
			);

			return {
				decayed: result1.changes,
				deleted: result2.changes,
			};
		});
	}

	async purge(threshold: number): Promise<number> {
		await this.init();
		return this.withDb(async (db) => {
			const result = await db.run(
				sql`DELETE FROM memories WHERE weight < ${threshold}`,
			);
			return result.changes;
		});
	}

	async getStats(): Promise<MemoryStats> {
		await this.init();
		return this.withDb(async (db) => {
			const memCount = await db
				.select({ c: sql<number>`count(*)` })
				.from(schema.memories)
				.get();
			const taskCount = await db
				.select({ c: sql<number>`count(*)` })
				.from(schema.tasks)
				.get();
			const avgScore = await db
				.select({ avg: schema.tasks.taskScore })
				.from(schema.tasks)
				.where(sql`${schema.tasks.taskScore} IS NOT NULL`)
				.get();

			const topRows = await db
				.select({
					content: schema.memories.content,
					weight: schema.memories.weight,
					retrievalCount: schema.memories.retrievalCount,
				})
				.from(schema.memories)
				.orderBy(desc(schema.memories.weight))
				.limit(10);

			return {
				totalMemories: memCount?.c ?? 0,
				taskCount: taskCount?.c ?? 0,
				avgTaskScore: avgScore?.avg ?? 0,
				topMemories: topRows.map((r) => ({
					content: r.content,
					weight: r.weight ?? 1.0,
					retrievalCount: r.retrievalCount ?? 0,
				})),
			};
		});
	}

	async getTopByWeight(limit: number = 5): Promise<Memory[]> {
		await this.init();
		return this.withDb(async (db) => {
			const rows = await db
				.select({
					id: schema.memories.id,
					content: schema.memories.content,
					category: schema.memories.category,
					weight: schema.memories.weight,
					createdAt: schema.memories.createdAt,
					retrievalCount: schema.memories.retrievalCount,
				})
				.from(schema.memories)
				.orderBy(desc(schema.memories.weight))
				.limit(limit);

			return rows.map((r) => ({
				id: r.id,
				content: r.content,
				category: r.category as MemoryCategory,
				weight: r.weight ?? 1.0,
				score: r.weight ?? 1.0,
				createdAt: r.createdAt,
				retrievalCount: r.retrievalCount ?? 0,
			}));
		});
	}

	async insertRawMemory(
		content: string,
		category: MemoryCategory,
		weight: number,
	): Promise<string> {
		await this.init();
		const id = randomUUID();
		const now = Math.floor(Date.now() / 1000);

		await this.withDb(async (db) => {
			await db.insert(schema.memories).values({
				id,
				content,
				category,
				weight,
				createdAt: now,
				sourceTask: this.currentTaskId,
			});
		});

		return id;
	}

	async embedPending(): Promise<number> {
		await this.init();

		const rows = await this.withDb(async (db) => {
			return db
				.select({
					id: schema.memories.id,
					content: schema.memories.content,
				})
				.from(schema.memories)
				.where(sql`${schema.memories.embedding} IS NULL`);
		});

		if (rows.length === 0) return 0;

		const embedded: Array<{ id: string; embedding: Buffer }> = [];
		for (const row of rows) {
			const vec = await this.embed(row.content);
			embedded.push({ id: row.id, embedding: vecBuf(vec) });
		}

		await this.withDb(async (db) => {
			for (const e of embedded) {
				await db
					.update(schema.memories)
					.set({ embedding: e.embedding })
					.where(eq(schema.memories.id, e.id));
			}
		});

		return rows.length;
	}

	async contradictMemory(
		memoryId: string,
		correction?: string,
	): Promise<{ deleted: boolean; correctionId?: string }> {
		await this.init();

		const deleted = await this.withDb(async (db) => {
			await db.delete(schema.memories).where(eq(schema.memories.id, memoryId));
			await db
				.delete(schema.memoryRetrievals)
				.where(eq(schema.memoryRetrievals.memoryId, memoryId));
			return true;
		});

		let correctionId: string | undefined;
		if (correction && deleted) {
			const embedding = await this.embed(correction);
			const id = randomUUID();
			const now = Math.floor(Date.now() / 1000);
			await this.withDb(async (db) => {
				await db.insert(schema.memories).values({
					id,
					content: correction,
					embedding: vecBuf(embedding),
					category: "correction" as MemoryCategory,
					weight: 2.0,
					createdAt: now,
					sourceTask: this.currentTaskId,
				});
			});
			correctionId = id;
		}

		return { deleted, correctionId };
	}

	async penalizeMemory(memoryId: string, factor: number): Promise<void> {
		await this.init();
		await this.withDb(async (db) => {
			const currentWeight = await db
				.select({ weight: schema.memories.weight })
				.from(schema.memories)
				.where(eq(schema.memories.id, memoryId))
				.get();

			if (currentWeight) {
				await db
					.update(schema.memories)
					.set({
						weight: Math.max((currentWeight.weight ?? 1.0) * factor, 0.1),
					})
					.where(eq(schema.memories.id, memoryId));
			}
		});
	}

	async close(): Promise<void> {
		this.initialized = false;
	}
}
