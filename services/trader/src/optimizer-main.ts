/**
 * OPTIMIZER — STANDALONE ENTRY (de-tenanting hotfix, 2026-08-04). The hourly
 * evidence engine runs in its OWN supervised process: the trading hot path
 * shares nothing with instrumentation. Same module, unchanged behavior.
 * Run: node .../tsx/dist/cli.mjs src/optimizer-main.ts  (log: optimizer.log)
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
process.on("unhandledRejection", (e) => console.error(`⚠️ optimizer rejection (survived): ${e instanceof Error ? e.message.slice(0, 160) : e}`));
process.on("uncaughtException", (e) => console.error(`⚠️ optimizer exception (survived): ${e instanceof Error ? e.message.slice(0, 200) : e}`));
import { loadConfig } from "@hermes/core";
import { startManifestOptimizer } from "./live/optimizer.js";

const cfg = loadConfig();
console.log("🧪 OPTIMIZER standalone — evidence engine off the trading hot path");
startManifestOptimizer(cfg);
setInterval(() => {}, 1 << 30); // hold the event loop
