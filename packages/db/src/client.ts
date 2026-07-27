import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL ?? "postgres://hermes:hermes@localhost:5433/hermes";

// Per-process pool width. The dashboard's root page fires ~25 analytics
// queries in one Promise.all — through the old hard-coded max of 5 they ran
// in five serial waves (~8-14s renders, 2026-07-27 incident). The dashboard
// starts with PG_POOL_MAX=25 so the burst runs in one wave; services that
// don't set it keep the conservative 5.
const sql = postgres(url, { max: Number(process.env.PG_POOL_MAX ?? 5) });

export const db = drizzle(sql, { schema });
export type Db = typeof db;
