/**
 * Generate the THROWAWAY live-lane hot wallet.
 *
 *   node ops/live/generate-wallet.mjs
 *
 * Policy (the testnet-deployer pattern, applied to the live lane):
 *  - keypair generated locally, dependency-free (node crypto ed25519)
 *  - the secret is written ONLY into the gitignored repo-root .env
 *    (TRADER_WALLET_SECRET_KEY, standard Solana base58 64-byte format)
 *  - stdout prints ONLY the public address — the secret never leaves .env
 *  - refuses to overwrite an existing key (rotate by clearing the var first)
 *  - fund it with pocket change only: the live lane is code-capped at
 *    LIVE_MAX_POSITION_USD × LIVE_MAX_CONCURRENT exposure and
 *    LIVE_DAILY_LOSS_CAP_USD/day. Never send this address more than you are
 *    fully prepared to lose — it is a hot key on a Windows desktop.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");

// ── base58 (Bitcoin alphabet), dependency-free ──────────────────────────────
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(buf) {
  let x = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (x > 0n) {
    out = ALPHA[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ── ed25519 keypair via node crypto; extract raw 32-byte seed + pubkey ──────
// PKCS8 DER for ed25519 = 16-byte header + 32-byte seed (seed is the last 32).
// SPKI DER for ed25519 = 12-byte header + 32-byte pubkey (last 32).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
// Solana secret-key convention: 64 bytes = seed || pubkey.
const secret64 = Buffer.concat([seed, pub]);
const address = base58(pub);
const secretB58 = base58(secret64);

// ── write into .env, refusing to clobber ────────────────────────────────────
const env = readFileSync(ENV_PATH, "utf8");
const m = env.match(/^TRADER_WALLET_SECRET_KEY=(.*)$/m);
if (m && m[1].trim() !== "") {
  console.error("REFUSED: TRADER_WALLET_SECRET_KEY is already set in .env — clear it first to rotate.");
  process.exit(1);
}
const next = m
  ? env.replace(/^TRADER_WALLET_SECRET_KEY=.*$/m, `TRADER_WALLET_SECRET_KEY=${secretB58}`)
  : env.trimEnd() + `\nTRADER_WALLET_SECRET_KEY=${secretB58}\n`;
writeFileSync(ENV_PATH, next);

console.log("Throwaway live-lane wallet generated. Secret written to .env (gitignored) — it is shown nowhere else.");
console.log("");
console.log(`  ADDRESS: ${address}`);
console.log("");
console.log("Fund with pocket change only (live lane is code-capped). Suggested first funding: ~$60 SOL");
console.log("(covers LIVE_MAX_CONCURRENT=2 × LIVE_MAX_POSITION_USD=$25 + fees).");
