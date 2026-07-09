import "dotenv/config";
import { loadConfig, runSafetyPipeline } from "@hermes/core";

/**
 * One-shot safety probe for a single mint — no DB required.
 * Usage: pnpm --filter @hermes/scout probe <mint>
 */
const mint = process.argv[2];
if (!mint) {
  console.error("usage: pnpm --filter @hermes/scout probe <mint-address>");
  process.exit(1);
}

const cfg = loadConfig();
const verdict = await runSafetyPipeline(cfg, { mint, chain: "solana" });

for (const check of verdict.checks) {
  console.log(`${check.passed ? "✓ PASS" : "✗ FAIL"}  ${check.checkName}`);
  console.log(`        ${JSON.stringify(check.evidence)}`);
}
console.log(`\nVERDICT: ${verdict.passed ? "✅ PASSES safety pipeline" : "❌ REJECTED"}`);
process.exit(0);
