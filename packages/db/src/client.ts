import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgres://hermes:hermes@localhost:5432/hermes";

const sql = postgres(url, { max: 5 });

export const db = drizzle(sql, { schema });
export type Db = typeof db;
