// Root .env, resolved explicitly — bare "dotenv/config" reads cwd
// (services/newsdesk), where no .env lives; the desk ran on pure defaults
// its whole life until the Groq key came up empty (2026-07-28).
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { resolve } from "node:path";
// ONE NEWSDESK ONLY — it ran lock-less and sat dead 87.8h unnoticed (2026-07-23).
import { acquireSingletonLock } from "@hermes/core";
acquireSingletonLock(resolve(import.meta.dirname, "../../../.hermes-newsdesk.pid"), "newsdesk");
import { generate } from "./generate.js";
import { generateSignals } from "./signals.js";

// News desk daemon — a slow, off-critical-path loop. Default 15 min so it never
// competes with the trader for CPU/RAM (qwen is heavy) or DexScreener rate budget.
// NOT part of the overnight supervised set: it's read-side and must not add
// failure surface to a live trading window. Run standalone when you want news.
const INTERVAL_MS = Number(process.env.NEWSDESK_INTERVAL_MS ?? 15 * 60 * 1000);

async function main() {
  console.log(`📰 newsdesk daemon up — cycle every ${(INTERVAL_MS / 60000).toFixed(0)}min`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Proprietary signals FIRST — pure data, independent of Ollama, so the feed is
    // never dead even when the LLM is offline or thrashing under live-trade load.
    try {
      await generateSignals();
    } catch (err) {
      console.error("signals cycle error (continuing):", err);
    }
    // LLM narrative brief + movers — degrades to a skip if Ollama is down.
    try {
      await generate();
    } catch (err) {
      console.error("newsdesk cycle error (continuing):", err);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
