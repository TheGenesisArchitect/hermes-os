// Operator-triggered digest send. NEVER wired into the daemon loop — cohort
// mail goes out on a human's command only.
//   npx tsx services/newsdesk/src/sendDigest.ts you@example.com [more@...]
// With no args: renders the dashboard preview only.
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { sendDigest, fetchCohortEmails } from "./digest.js";

// Modes:
//   sendDigest.ts a@x.com b@y.com   → send to explicit addresses
//   sendDigest.ts --cohort-count    → report cohort size only (no send)
//   sendDigest.ts --cohort          → send to the ambassador cohort, one email
//                                     per recipient (privacy), 650ms spacing
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--cohort-count") || args.includes("--cohort")) {
    const cohort = await fetchCohortEmails();
    if ("error" in cohort) {
      console.log(`📧 cohort: BLOCKED — ${cohort.error}`);
      return;
    }
    console.log(`📧 cohort: ${cohort.emails.length} recipient(s) from ${cohort.source}`);
    if (args.includes("--cohort-count")) return;
    let sent = 0;
    for (const email of cohort.emails) {
      const status = await sendDigest([email]);
      console.log(`  ${status}`);
      if (status.startsWith("sent")) sent++;
      await new Promise((r) => setTimeout(r, 650));
    }
    console.log(`📧 cohort send complete: ${sent}/${cohort.emails.length}`);
    return;
  }
  const to = args.filter((a) => a.includes("@"));
  console.log(`📧 digest: ${await sendDigest(to)}`);
}
main().then(() => process.exit(0));
