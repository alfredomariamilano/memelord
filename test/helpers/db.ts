import { connect, type Database as TursoDatabase } from "@tursodatabase/database";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

/**
 * Create an in-memory SQLite database for unit tests.
 * Uses :memory: — faster, no disk I/O, each connection is isolated.
 */
export async function createTestDb(): Promise<TursoDatabase> {
  const tursoDb = await connect(":memory:");
  await tursoDb.exec("PRAGMA busy_timeout = 5000");
  return tursoDb;
}

/**
 * Create a temporary file-based SQLite database for integration tests.
 * Returns the TursoDatabase connection and the path for cleanup.
 */
export async function createTempDb(): Promise<{ db: TursoDatabase; path: string }> {
  const path = join(process.cwd(), "test-db-" + randomUUID() + ".db");
  if (existsSync(path)) rmSync(path);
  const db = await connect(path);
  await db.exec("PRAGMA busy_timeout = 5000");
  return { db, path };
}

/**
 * Create the memelord schema tables on a Turso database connection.
 * Used by tests to bypass runMigrations() which requires a migrations folder.
 */
export async function createSchema(db: TursoDatabase): Promise<void> {
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

/**
 * Close a database connection and remove the temp file if applicable.
 */
export function closeDb(db: TursoDatabase, path?: string): void {
  db.close();
  if (path && existsSync(path)) rmSync(path);
}
