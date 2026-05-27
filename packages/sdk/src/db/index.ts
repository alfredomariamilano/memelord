import type { Database as TursoDatabase } from "@tursodatabase/database";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import type { TursoDatabaseDatabase } from "drizzle-orm/tursodatabase/driver-core";
import { migrate } from "drizzle-orm/tursodatabase/migrator";

export function createDrizzleDb(tursoDb: TursoDatabase) {
	return drizzle({ client: tursoDb });
}

export async function runMigrations(
	drizzleDb: TursoDatabaseDatabase,
	migrationsFolder?: string,
): Promise<void> {
	const folder = migrationsFolder ?? "drizzle";
	await migrate(drizzleDb, { migrationsFolder: folder });
}
