import type { Database as TursoDatabase } from "@tursodatabase/database";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import * as schema from "./schema.js";

export function createDrizzleDb(tursoDb: TursoDatabase) {
  return drizzle({ client: tursoDb });
}


