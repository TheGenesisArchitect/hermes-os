// Operator-triggered digest send. NEVER wired into the daemon loop — cohort
// mail goes out on a human's command only.
//   npx tsx services/newsdesk/src/sendDigest.ts you@example.com [more@...]
// With no args: renders the dashboard preview only.
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { sendDigest } from "./digest.js";

const to = process.argv.slice(2).filter((a) => a.includes("@"));
sendDigest(to).then((status) => {
  console.log(`📧 digest: ${status}`);
  process.exit(0);
});
