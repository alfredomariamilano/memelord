# Draft: Turso Embedded Migrations

## Requirements (confirmed)
- Replace programmatic `pushSchema()` (from `drizzle-kit/api`) with proper embedded migrations
- Generate migration SQL files from Drizzle schema
- Run migrations at app startup via `migrate()` from `drizzle-orm/tursodatabase/migrator`
- Must work with Turso (cloud-managed SQLite) — not local SQLite
- drizzle-kit generate runs at build time (developer), migrate() runs at app startup (user)

## Technical Decisions
- **Dialect**: `turso` (not `sqlite`) in drizzle.config.ts — Turso has its own dialect config
- **Migration runner**: `migrate()` from `drizzle-orm/tursodatabase/migrator` — reads `{migrationsFolder}/{subdir}/migration.sql` files
- **Migration directory**: `packages/sdk/drizzle/` — matches existing `out: "./drizzle"` config
- **Migration invocation**: Called in `store.ts:init()` and exported for CLI standalone use
- **Migration table**: `__drizzle_migrations` (Drizzle default) — tracks applied migrations

## Research Findings
- Drizzle v1.0.0-beta.22 Turso migrator (`tursodatabase/migrator.js`):
  ```ts
  async function migrate(db, config) {
    const migrations = readMigrationFiles(config);
    return await db.dialect.migrate(migrations, db, config);
  }
  ```
- `readMigrationFiles(config)` scans `config.migrationsFolder` for subdirectories containing `migration.sql`
- Migration SQL files separated by `--> statement-breakpoint`
- `drizzle-kit generate` creates these files from schema changes
- Need `dbCredentials: { url, authToken }` for Turso dialect in drizzle.config.ts

## Current State Investigation
- `drizzle.config.ts` uses `dialect: "sqlite"` — needs to be `dialect: "turso"`
- `store.ts` already has `createDrizzleDb()` and uses Drizzle ORM throughout
- `db/index.ts` exports `createDrizzleDb()` — clean factory pattern
- No migrations directory or files exist yet
- SDK package.json includes `drizzle-kit` and `drizzle-orm` as dependencies ✓
- `drizzle-kit generate` command would need correct working directory (from project root or sdk dir)

## Open Questions
- Where should migration invocation live? In store.ts `init()` or as a separate call the CLI does?
- Should we add a `memelord migrate` CLI command for manual migration running?
- What env vars are used for Turso connection in development (for drizzle-kit generate)?

## Scope Boundaries
- INCLUDE: Fix drizzle.config.ts, generate initial migration SQL, add migration runner, wire into startup
- INCLUDE: Export migration function from db/index.ts
- INCLUDE: CLI `memelord init` already creates the database — migrations would run automatically
- EXCLUDE: Removing the existing one-time migration check (`UPDATE memories SET embedding = NULL WHERE ...`)
- EXCLUDE: Rewriting the existing schema

## Implementation Plan (Draft)

### Files to modify:
1. **packages/sdk/drizzle.config.ts** — Fix dialect to `turso`, add `dbCredentials` (nullable for offline generation), keep `out: "./drizzle"`
2. **packages/sdk/src/db/index.ts** — Add `runMigrations(tursoDb, config?)` function using `migrate()` from `drizzle-orm/tursodatabase/migrator`
3. **packages/sdk/src/store.ts** — Call migration runner in `init()` before table operations
4. **new: packages/sdk/drizzle/** — Directory for generated migration files (created by drizzle-kit generate)

### Migration file structure:
```
packages/sdk/drizzle/
  0000_initial/
    migration.sql
  meta/
    _journal.json
```

### TODO approach:
1. Fix drizzle.config.ts (use `dialect: "turso"`)
2. Generate initial migration SQL via `bunx drizzle-kit generate`
3. Add `runMigrations()` to db/index.ts
4. Wire migration into store.ts `init()`
5. Test: verify migration table created, tables exist, no errors
