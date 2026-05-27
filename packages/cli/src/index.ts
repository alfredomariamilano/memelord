#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "@tursodatabase/database";
import { startMcpServer } from "./mcp.js";

interface CountRow {
	c?: number;
	avg?: number | null;
}
interface CategoryRow {
	category?: string;
	c?: number;
}
interface MemoryRow {
	id?: unknown;
	content?: unknown;
	weight?: unknown;
	retrieval_count?: unknown;
	created_at?: unknown;
	emb_len?: unknown;
	category?: string;
}

// MCP config types
interface McpServersConfig {
	command: string;
	args: Array<string>;
	env?: Record<string, string>;
}
interface McporterMcpServersConfig {
	command: string;
	args: Array<string>;
	env?: Record<string, string>;
}
interface OpencodeMcpConfig {
	type: string;
	command: Array<string>;
	environment: Record<string, string>;
	enabled: boolean;
}

// MCP config container types
interface McpServersMap {
	[key: string]: McpServersConfig;
}
interface McporterMcpServersMap {
	[key: string]: McporterMcpServersConfig;
}
interface OpencodeMcpMap {
	[key: string]: OpencodeMcpConfig;
}

interface McpConfig {
	mcpServers?: McpServersMap;
}
interface McporterConfig {
	mcpServers?: McporterMcpServersMap;
}
interface OpenCodeConfig {
	mcp?: OpencodeMcpMap;
}

// Claude Code hook types
interface ClaudeSettingsHooks {
	[event: string]: Array<Record<string, unknown>>;
}
interface ClaudeSettings {
	hooks?: ClaudeSettingsHooks;
}

// Task row type
interface TaskRow {
	id?: unknown;
	description?: unknown;
	task_score?: unknown;
	tokens_used?: unknown;
	tool_calls?: unknown;
	errors?: unknown;
	user_corrections?: unknown;
	completed?: unknown;
	started_at?: unknown;
	finished_at?: unknown;
}
interface RetrievalRow {
	memory_id?: unknown;
	similarity?: unknown;
	self_report?: unknown;
	credit?: unknown;
	preview?: unknown;
	category?: string;
}

const command = process.argv[2];

function getDbPath(): string {
	const dataDir = resolve(process.env.MEMELORD_DIR ?? ".memelord");
	return join(dataDir, "memory.db");
}

/** Open a short-lived connection, run fn, close. */
async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
	const { connect } = await import("@tursodatabase/database");
	const dbPath = getDbPath();
	if (!existsSync(dbPath)) {
		console.log("No memelord database found. Run 'memelord init' first.");
		process.exit(0);
	}
	const db = await connect(dbPath, {
		experimental: ["multiprocess_wal"],
	});
	await db.exec("PRAGMA busy_timeout = 5000");
	try {
		return await fn(db);
	} finally {
		db.close();
	}
}

/**
 * Resolve how to invoke memelord.
 * If installed globally (in node_modules/.bin), just "memelord".
 * Otherwise, use node + absolute path to the built cli.mjs.
 */
function getCliCommand(): { command: string; args: string[] } {
	const execPath = process.argv[1] ?? "";
	if (execPath.includes("node_modules")) {
		return { command: "memelord", args: [] };
	}
	// Not installed globally — use absolute path to this script
	return { command: "node", args: [resolve(execPath)] };
}

function timeAgo(epochSec: number): string {
	const diff = Math.floor(Date.now() / 1000) - epochSec;
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

if (command === "hook") {
	const { runHook } = await import("./hooks.js");
	await runHook(process.argv[3] ?? "");
} else if (!command || command === "serve") {
	await startMcpServer();
} else if (command === "status") {
	await withDb(async (db) => {
		const memCount =
			(
				(await (
					await db.prepare("SELECT COUNT(*) as c FROM memories")
				).get()) as CountRow
			)?.c ?? 0;
		const taskCount =
			(
				(await (
					await db.prepare(
						"SELECT COUNT(*) as c FROM tasks WHERE finished_at IS NOT NULL",
					)
				).get()) as CountRow
			)?.c ?? 0;
		const avgScore = (
			(await (
				await db.prepare(
					"SELECT AVG(task_score) as avg FROM tasks WHERE task_score IS NOT NULL",
				)
			).get()) as CountRow
		)?.avg;
		const categories = ((await (
			await db.prepare(
				"SELECT category, COUNT(*) as c FROM memories GROUP BY category ORDER BY c DESC",
			)
		).all()) ?? []) as CategoryRow[];

		console.log(`memelord status:`);
		console.log(`  Memories:  ${memCount}`);
		console.log(`  Tasks:     ${taskCount}`);
		console.log(`  Avg score: ${avgScore?.toFixed(3) ?? "N/A"}`);
		console.log(
			`  By category: ${categories.map((r) => `${r.category}=${r.c}`).join(", ")}`,
		);

		const topMems = ((await (
			await db.prepare(
				"SELECT content, weight, retrieval_count FROM memories ORDER BY weight DESC LIMIT 5",
			)
		).all()) ?? []) as MemoryRow[];

		if (topMems.length > 0) {
			console.log(`\n  Top by weight:`);
			for (const m of topMems) {
				const preview =
					(m.content as string).length > 70
						? `${(m.content as string).slice(0, 70)}...`
						: (m.content as string);
				console.log(
					`    [w=${(m.weight as number).toFixed(2)}, used=${m.retrieval_count as number}x] ${preview}`,
				);
			}
		}
	});
} else if (command === "memories") {
	await withDb(async (db) => {
		const filter = process.argv[3]; // optional category filter

		let query =
			"SELECT id, content, category, weight, retrieval_count, created_at, length(embedding) as emb_len FROM memories";
		const params: unknown[] = [];
		if (filter) {
			query += " WHERE category = ?";
			params.push(filter);
		}
		query += " ORDER BY created_at DESC";

		const rows = ((await (await db.prepare(query)).all(...params)) ??
			[]) as MemoryRow[];

		if (rows.length === 0) {
			console.log(
				filter ? `No ${filter} memories found.` : "No memories found.",
			);
			process.exit(0);
		}

		console.log(`${rows.length} memories${filter ? ` (${filter})` : ""}:\n`);

		for (const r of rows) {
			const embStatus =
				r.emb_len === 1536 ? "OK" : r.emb_len ? `${r.emb_len}B!` : "pending";
			console.log(
				`--- [${r.category ?? ""}] w=${(r.weight as number).toFixed(2)} | used=${r.retrieval_count as number}x | emb=${embStatus} | ${timeAgo(r.created_at as number)} ---`,
			);
			console.log((r.content as string).slice(0, 500));
			if ((r.content as string).length > 500)
				console.log(`  ...(${(r.content as string).length} chars total)`);
			console.log();
		}
	});
} else if (command === "tasks") {
	await withDb(async (db) => {
		const limit = parseInt(process.argv[3] ?? "10", 10);

		const rows = ((await (
			await db.prepare(`
      SELECT id, description, tokens_used, tool_calls, errors, user_corrections,
             completed, task_score, started_at, finished_at
      FROM tasks
      ORDER BY started_at DESC
      LIMIT ?
    `)
		).all(limit)) ?? []) as TaskRow[];

		if (rows.length === 0) {
			console.log("No tasks found.");
			process.exit(0);
		}

		console.log(`Last ${rows.length} tasks:\n`);

		for (const t of rows) {
			const status =
				(t.finished_at as number) != null
					? t.completed
						? "completed"
						: "failed"
					: "in-progress";
			const score =
				(t.task_score as number) != null
					? (t.task_score as number).toFixed(3)
					: "N/A";
			const desc = ((t.description ?? "") as string).slice(0, 100);
			const when =
				(t.started_at as number) != null
					? timeAgo(t.started_at as number)
					: "?";

			console.log(
				`[${status}] score=${score} | ${t.tokens_used ?? "?"}tok, ${t.tool_calls ?? "?"}calls, ${t.errors ?? 0}err, ${t.user_corrections ?? 0}corr | ${when}`,
			);
			console.log(`  ${desc}`);

			const retrievals = ((await (
				await db.prepare(`
        SELECT r.memory_id, r.similarity, r.self_report, r.credit,
               substr(m.content, 1, 80) as preview, m.category
         FROM memory_retrievals r
          JOIN memories m ON r.memory_id = m.id
          WHERE r.task_id = ?
        `)
			).all(Number(t.id))) ?? []) as RetrievalRow[];

			if (retrievals.length > 0) {
				for (const r of retrievals) {
					const rated =
						(r.self_report as number) != null
							? ` rated=${r.self_report as number}/3`
							: "";
					const credit =
						(r.credit as number) != null
							? ` credit=${(r.credit as number).toFixed(2)}`
							: "";
					console.log(
						`    -> [${r.category as string}] sim=${((r.similarity ?? 0) as number).toFixed(3)}${rated}${credit} "${r.preview as string}..."`,
					);
				}
			}

			const created = ((await (
				await db.prepare(`
        SELECT category, substr(content, 1, 60) as preview
        FROM memories WHERE source_task = ?
      `)
			).all(Number(t.id))) ?? []) as RetrievalRow[];

			if (created.length > 0) {
				for (const c of created) {
					console.log(
						`    <- stored [${c.category as string}] "${c.preview as string}..."`,
					);
				}
			}

			console.log();
		}
	});
} else if (command === "log") {
	await withDb(async (db) => {
		const limit = parseInt(process.argv[3] ?? "20", 10);

		const events: { time: number; text: string }[] = [];

		const tasks = ((await (
			await db.prepare(`
      SELECT description, task_score, tokens_used, tool_calls, errors,
             user_corrections, completed, started_at, finished_at
      FROM tasks ORDER BY started_at DESC LIMIT ?
    `)
		).all(limit)) ?? []) as TaskRow[];

		for (const t of tasks) {
			const status = (t.completed as boolean) ? "OK" : "FAIL";
			const score =
				(t.task_score as number) != null
					? (t.task_score as number).toFixed(2)
					: "?";
			const desc = ((t.description ?? "") as string).slice(0, 80);
			events.push({
				time: t.started_at as number,
				text: `TASK [${status}] score=${score} ${t.tokens_used ?? "?"}tok ${t.errors ?? 0}err — ${desc}`,
			});
		}

		const mems = ((await (
			await db.prepare(`
      SELECT content, category, weight, created_at
      FROM memories ORDER BY created_at DESC LIMIT ?
    `)
		).all(limit)) ?? []) as MemoryRow[];

		for (const m of mems) {
			events.push({
				time: m.created_at as number,
				text: `MEM  [${m.category as string}] w=${(m.weight as number).toFixed(2)} — ${(m.content as string).slice(0, 80)}`,
			});
		}

		events.sort((a, b) => a.time - b.time);

		console.log("Timeline:\n");
		for (const e of events) {
			console.log(`${timeAgo(e.time).padStart(8)}  ${e.text}`);
		}
	});
} else if (command === "search") {
	const query = process.argv.slice(3).join(" ");
	if (!query) {
		console.error("Usage: memelord search <query>");
		process.exit(1);
	}

	const { createMemoryStore } = await import("memelord");
	const { createEmbedder } = await import("./embedder.js");

	const embed = await createEmbedder();
	const store = createMemoryStore({
		dbPath: getDbPath(),
		sessionId: "cli-search",
		embed,
	});
	await store.init();

	const result = await store.startTask(query);

	if (result.memories.length === 0) {
		console.log("No relevant memories found.");
	} else {
		console.log(`Top ${result.memories.length} results for "${query}":\n`);
		for (const m of result.memories) {
			console.log(
				`[${m.category}] score=${m.score.toFixed(3)} w=${m.weight.toFixed(2)}`,
			);
			console.log(`  ${m.content.slice(0, 200)}`);
			console.log();
		}
	}

	await store.close();
} else if (command === "purge") {
	const threshold = parseFloat(process.argv[3] ?? "0.5");
	if (Number.isNaN(threshold)) {
		console.error(`Invalid threshold: ${process.argv[3]}`);
		process.exit(1);
	}
	await withDb(async (db) => {
		const result = await (
			await db.prepare("DELETE FROM memories WHERE weight < ?")
		).run(threshold);
		console.log(`Purged ${result.changes} memories below weight ${threshold}`);
	});
} else if (command === "init") {
	// -------------------------------------------------------------------------
	// memelord init — one-shot setup for Claude Code, Codex, OpenCode, and OpenClaw
	// -------------------------------------------------------------------------
	const targetDir = resolve(process.argv[3] ?? ".");
	const cli = getCliCommand();

	// 1. Create .memelord directory
	const dataDir = join(targetDir, ".memelord");
	if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

	// 2. Add .memelord to .gitignore
	const gitignorePath = join(targetDir, ".gitignore");
	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		if (!content.includes(".memelord")) {
			writeFileSync(gitignorePath, `${content.trimEnd()}\n.memelord/\n`);
			console.log("  Updated .gitignore");
		}
	} else {
		writeFileSync(gitignorePath, ".memelord/\n");
		console.log("  Created .gitignore");
	}

	// 3. Claude Code — .mcp.json
	const mcpJsonPath = join(targetDir, ".mcp.json");
	let mcpConfig: McpConfig = {};
	if (existsSync(mcpJsonPath)) {
		try {
			mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
		} catch {}
	}
	if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
	mcpConfig.mcpServers.memelord = {
		command: cli.command,
		args: [...cli.args, "serve"],
		env: { MEMELORD_DIR: join(targetDir, ".memelord") },
	};
	writeFileSync(mcpJsonPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
	console.log("  Wrote .mcp.json (Claude Code)");

	// 4. Codex — .codex/config.toml
	const codexDir = join(targetDir, ".codex");
	if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });
	const codexTomlPath = join(codexDir, "config.toml");
	let codexContent = "";
	if (existsSync(codexTomlPath)) {
		codexContent = readFileSync(codexTomlPath, "utf-8");
	}
	if (!codexContent.includes("[mcp_servers.memelord]")) {
		const codexArgs = [...cli.args, "serve"].map((a) => `"${a}"`).join(", ");
		codexContent += `
[mcp_servers.memelord]
command = "${cli.command}"
args = [${codexArgs}]
env = { MEMELORD_DIR = "${join(targetDir, ".memelord")}" }
enabled = true
`;
		writeFileSync(codexTomlPath, codexContent.trimStart());
		console.log("  Wrote .codex/config.toml (Codex)");
	} else {
		console.log("  .codex/config.toml already has memelord");
	}

	// 5. OpenCode — opencode.json
	const opencodePath = join(targetDir, "opencode.json");
	let opencodeConfig: OpenCodeConfig = {};
	if (existsSync(opencodePath)) {
		try {
			opencodeConfig = JSON.parse(readFileSync(opencodePath, "utf-8"));
		} catch {}
	}
	if (!opencodeConfig.mcp) opencodeConfig.mcp = {};
	opencodeConfig.mcp.memelord = {
		type: "local",
		command: [cli.command, ...cli.args, "serve"],
		environment: { MEMELORD_DIR: join(targetDir, ".memelord") },
		enabled: true,
	};
	writeFileSync(opencodePath, `${JSON.stringify(opencodeConfig, null, 2)}\n`);
	console.log("  Wrote opencode.json (OpenCode)");

	// 6. OpenClaw — config/mcporter.json
	const mcporterDir = join(targetDir, "config");
	if (!existsSync(mcporterDir)) mkdirSync(mcporterDir, { recursive: true });
	const mcporterPath = join(mcporterDir, "mcporter.json");
	let mcporterConfig: McporterConfig = {};
	if (existsSync(mcporterPath)) {
		try {
			mcporterConfig = JSON.parse(readFileSync(mcporterPath, "utf-8"));
		} catch {}
	}
	if (!mcporterConfig.mcpServers) mcporterConfig.mcpServers = {};
	if (mcporterConfig.mcpServers)
		mcporterConfig.mcpServers.memelord = {
			command: cli.command,
			args: [...cli.args, "serve"],
			env: { MEMELORD_DIR: join(targetDir, ".memelord") },
		};
	writeFileSync(mcporterPath, `${JSON.stringify(mcporterConfig, null, 2)}\n`);
	console.log("  Wrote config/mcporter.json (OpenClaw)");

	// 7. Claude Code hooks — ~/.claude/settings.json
	const settingsPath = join(
		process.env.HOME ?? "~",
		".claude",
		"settings.json",
	);
	if (existsSync(settingsPath)) {
		let settings: ClaudeSettings = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {}
		if (!settings.hooks) settings.hooks = {};

		const hookDefs: Record<
			string,
			{ hookName: string; timeout: number; matcher?: string }
		> = {
			SessionStart: { hookName: "session-start", timeout: 10 },
			PostToolUse: { hookName: "post-tool-use", timeout: 5, matcher: "*" },
			Stop: { hookName: "stop", timeout: 15 },
			SessionEnd: { hookName: "session-end", timeout: 30 },
		};

		for (const [event, def] of Object.entries(hookDefs)) {
			const cmd =
				cli.command === "memelord"
					? `memelord hook ${def.hookName}`
					: `${cli.command} ${cli.args.join(" ")} hook ${def.hookName}`;
			const hookObj: Record<string, unknown> = {
				hooks: [{ type: "command", command: cmd, timeout: def.timeout }],
			};
			if (def.matcher)
				(hookObj as Record<string, unknown>).matcher = def.matcher;

			// Replace any existing memelord hooks, or add new
			const existing: Array<Record<string, unknown>> = (settings.hooks?.[
				event
			] ?? []) as Array<Record<string, unknown>>;
			const idx = existing.findIndex((h: Record<string, unknown>) => {
				if (!Array.isArray(h.hooks)) return false;
				return h.hooks.some(
					(hh) =>
						typeof hh === "object" &&
						hh !== null &&
						typeof hh.command === "string" &&
						hh.command.includes("memelord"),
				);
			});
			if (idx >= 0) {
				existing[idx] = hookObj;
			} else {
				existing.push(hookObj);
			}
			settings.hooks[event] = existing;
		}

		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		console.log("  Updated ~/.claude/settings.json (hooks)");
	}

	console.log(`\nmemelord initialized in ${targetDir}`);
	console.log("Restart your coding agent to activate.");
} else if (command === "help" || command === "--help") {
	console.log(`memelord - Persistent memory system for coding agents

Usage:
  memelord init [dir]           Set up memelord for a project (Claude Code, Codex, OpenCode, OpenClaw)
  memelord serve                Start the MCP server (default)
  memelord hook <event>         Run a hook (session-start, post-tool-use, stop, session-end)
  memelord status               Overview: counts, categories, top memories
  memelord memories [category]  List all memories (optionally filter by category)
  memelord tasks [n]            Show last N tasks with retrievals and outcomes
  memelord log [n]              Compact timeline of tasks and memory events
  memelord search <query>       Search memories by semantic similarity
  memelord purge [threshold]    Delete memories below weight (default: 0.5)
  memelord help                 Show this help

Quick start:
  cd your-project && memelord init

Categories: correction, user, discovery, insight, consolidated

Environment:
  MEMELORD_DIR       Data directory (default: .memelord in project root)
  MEMELORD_MODEL     Embedding model override`);
} else {
	console.error(`Unknown command: ${command}. Run 'memelord help' for usage.`);
	process.exit(1);
}
