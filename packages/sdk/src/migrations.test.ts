import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { connect, type Database as TursoDatabase } from "@tursodatabase/database";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { createDrizzleDb, runMigrations } from "./db/index.js";

describe("runMigrations", () => {
  let tursoDb: TursoDatabase;
  let drizzleDb: ReturnType<typeof createDrizzleDb>;
  let dbPath: string;

  beforeEach(async () => {
    // Create a temporary database (no multiprocess_wal for Bun compatibility)
    dbPath = join(process.cwd(), "test-migration-db-" + randomUUID() + ".db");
    if (existsSync(dbPath)) rmSync(dbPath);
    tursoDb = await connect(dbPath);
    await tursoDb.exec("PRAGMA busy_timeout = 5000");
    drizzleDb = createDrizzleDb(tursoDb);
  });

  afterEach(async () => {
    tursoDb.close();
    if (existsSync(dbPath)) rmSync(dbPath);
  });

  test("creates all tables on first run", async () => {
    await runMigrations(drizzleDb);

    // Verify all 4 tables exist
    const tables = await tursoDb.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables.map((t: any) => t.name);

    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("memory_retrievals");
    expect(tableNames).toContain("meta");
    expect(tableNames).toContain("__drizzle_migrations"); // Drizzle migration tracking table
  });

  test("is idempotent — second run doesn't duplicate", async () => {
    await runMigrations(drizzleDb);

    // Run again — should not throw and should not create duplicate tables
    await runMigrations(drizzleDb);

    const tables = await tursoDb.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables.map((t: any) => t.name);

    // Each table should appear exactly once
    const counts = tableNames.reduce((acc: Record<string, number>, name) => {
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});

    for (const [name, count] of Object.entries(counts)) {
      expect(count).toBe(1);
    }
  });

  test("tracks migration in __drizzle_migrations", async () => {
    await runMigrations(drizzleDb);

    const migrations = await tursoDb.all("SELECT name, hash FROM __drizzle_migrations ORDER BY name");
    expect(migrations.length).toBe(1);
    expect(migrations[0].name).toMatch(/^2026/); // timestamp prefix
    expect(migrations[0].hash).toBeDefined();
  });

  test("creates composite PK on memory_retrievals", async () => {
    await runMigrations(drizzleDb);

    const schema = await tursoDb.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_retrievals'");
    expect(schema[0].sql).toMatch(/PRIMARY KEY\s+\(`memory_id`, `task_id`\)/);
  });
});
