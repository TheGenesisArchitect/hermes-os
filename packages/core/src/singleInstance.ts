/**
 * SINGLE-INSTANCE LOCK — one daemon per service, enforced at startup.
 *
 * Duplicate daemons have now caused real losses four separate ways in one
 * session: doubled paper entries (MILF/FIM, −$17.55/24h before the DB index),
 * doubled LIVE buys (BSTRAT ×2 — each process has its own in-flight claim
 * Set, so process-local guards cannot see each other), doubled recorder
 * arming, and — worst — two daemons running DIFFERENT code versions after a
 * partial restart, one of them failing every Meteora buy with errors the
 * deployed code could no longer produce. Restart hygiene has proven
 * unenforceable by hand (taskkill on Windows kills trees partially, pnpm
 * wrappers respawn children, and a stale kill target error leaves survivors).
 *
 * So the invariant lives here: a PID lockfile per service. On startup, if the
 * lock names a LIVING process, exit loudly — a duplicate that dies at boot is
 * a log line; a duplicate that trades is a capital loss. A dead PID is a stale
 * lock from a crash and is safely claimed. PID-reuse collisions are possible
 * in principle and accepted: the failure mode is one refused start, fixed by
 * deleting the lockfile.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export function acquireSingletonLock(lockPath: string, service: string): void {
  try {
    if (existsSync(lockPath)) {
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        let alive = true;
        try {
          process.kill(pid, 0); // signal 0 = existence probe, throws if dead
        } catch {
          alive = false;
        }
        if (alive) {
          console.error(
            `⛔ FATAL: another ${service} is already running (pid ${pid}, lock ${lockPath}). ` +
              `Refusing to start a duplicate — kill it first or delete the lock if it is stale.`,
          );
          process.exit(1);
        }
      }
    }
    writeFileSync(lockPath, String(process.pid));
    process.on("exit", () => {
      try {
        if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
      } catch {
        /* lock already gone or claimed by a successor */
      }
    });
  } catch (err) {
    // The lock must never PREVENT a legitimate start on fs weirdness — it only
    // exists to stop duplicates. Warn and continue.
    console.warn(`singleton lock warning (${service}): ${err instanceof Error ? err.message : err}`);
  }
}
