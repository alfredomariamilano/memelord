import {
	blob,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const memories = sqliteTable("memories", {
	id: text("id").primaryKey(),
	content: text("content").notNull(),
	embedding: blob("embedding", { mode: "buffer" }),
	category: text("category", {
		enum: ["correction", "insight", "user", "consolidated", "discovery"],
	}).notNull(),
	weight: real("weight").default(1.0),
	initialCost: integer("initial_cost").default(0),
	createdAt: integer("created_at").notNull(),
	lastRetrieved: integer("last_retrieved"),
	retrievalCount: integer("retrieval_count").default(0),
	sourceTask: text("source_task"),
});

export const tasks = sqliteTable("tasks", {
	id: text("id").primaryKey(),
	description: text("description"),
	embedding: blob("embedding", { mode: "buffer" }),
	tokensUsed: integer("tokens_used"),
	toolCalls: integer("tool_calls"),
	errors: integer("errors"),
	userCorrections: integer("user_corrections"),
	completed: integer("completed"),
	taskScore: real("task_score"),
	startedAt: integer("started_at"),
	finishedAt: integer("finished_at"),
});

export const memoryRetrievals = sqliteTable(
	"memory_retrievals",
	{
		memoryId: text("memory_id").notNull(),
		taskId: text("task_id").notNull(),
		similarity: real("similarity"),
		selfReport: real("self_report"),
		credit: real("credit"),
	},
	(table) => {
		return [
			primaryKey({ name: "pk", columns: [table.memoryId, table.taskId] }),
		];
	},
);

export const meta = sqliteTable("meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});
