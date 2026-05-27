CREATE TABLE `memories` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`embedding` blob,
	`category` text NOT NULL,
	`weight` real DEFAULT 1,
	`initial_cost` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`last_retrieved` integer,
	`retrieval_count` integer DEFAULT 0,
	`source_task` text
);
--> statement-breakpoint
CREATE TABLE `memory_retrievals` (
	`memory_id` text NOT NULL,
	`task_id` text NOT NULL,
	`similarity` real,
	`self_report` real,
	`credit` real,
	CONSTRAINT `pk` PRIMARY KEY(`memory_id`, `task_id`)
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY,
	`description` text,
	`embedding` blob,
	`tokens_used` integer,
	`tool_calls` integer,
	`errors` integer,
	`user_corrections` integer,
	`completed` integer,
	`task_score` real,
	`started_at` integer,
	`finished_at` integer
);
