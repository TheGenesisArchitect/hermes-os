import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const [b] = await q`SELECT id, realized_pnl_usd, exit_reason FROM positions WHERE id = 5131`;
console.log(`before: #${b.id} pnl ${b.realized_pnl_usd} (${b.exit_reason})`);
await q`UPDATE positions SET realized_pnl_usd = 0.5430325308840618,
  exit_price_usd = 0.00007898505438755352, exit_reason = 'manual_harvest'
  WHERE id = 5131 AND exit_reason = 'live_desync_empty'`;
await q`INSERT INTO audit_log (actor, action, details) VALUES ('hermes', 'ledger_correction', ${q.json({
  positionId: 5131, mint: "5v4e…Gzjj (BullPad)",
  from: { pnl: -3.02, reason: "live_desync_empty" },
  to: { pnl: 0.543, reason: "manual_harvest" },
  evidence: "chain sell tx 32ijre35… +0.0475 SOL vs buy 0.0423 SOL; fill #12938 recorded; position UPDATE failed then desync sweep wrote off — chain-truth ledger correction",
})}`;
const [a] = await q`SELECT realized_pnl_usd, exit_reason FROM positions WHERE id = 5131`;
console.log(`after: pnl ${a.realized_pnl_usd} (${a.exit_reason})`);
await q.end();
