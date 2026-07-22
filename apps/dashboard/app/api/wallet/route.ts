// WALLET INFO — address, on-chain balance, book context for the Wallet panel.
// The secret never leaves the server: only the derived public address and
// chain-read balances cross to the client.
import { NextResponse } from "next/server";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { sql } from "drizzle-orm";
import { db } from "@hermes/db";
import { loadConfig } from "@hermes/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function wallet(): Keypair | null {
  const raw = (process.env.TRADER_WALLET_SECRET_KEY ?? "").trim();
  if (!raw) return null;
  try {
    const secret = bs58.decode(raw);
    if (secret.length !== 64) return null;
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

export async function GET() {
  const w = wallet();
  if (!w) return NextResponse.json({ error: "no wallet key configured" }, { status: 503 });
  const cfg = loadConfig();
  let lamports: number | null = null;
  for (const rpc of cfg.rpcUrls) {
    try {
      lamports = await new Connection(rpc, "confirmed").getBalance(w.publicKey, "confirmed");
      break;
    } catch {
      /* walk the fallback list — same posture as the daemons' rpcPool */
    }
  }
  // Reconciler status carries the freshest SOL price and chain balance the
  // books trust — it doubles as the balance source when this process's own
  // RPC read fails (the reconciler proves the wallet every cycle anyway).
  const recon = (await db.execute(
    sql`SELECT value FROM config WHERE key = 'ledger_recon_status'`,
  )) as unknown as { value: { solUsd?: number; chainSol?: number; at?: string } }[];
  const solUsd = recon[0]?.value?.solUsd ?? null;
  let stale = false;
  if (lamports == null && recon[0]?.value?.chainSol != null) {
    lamports = recon[0].value.chainSol * 1e9;
    stale = true;
  }
  const sendReq = (await db.execute(
    sql`SELECT value FROM config WHERE key = 'wallet_send_request'`,
  )) as unknown as { value: Record<string, unknown> }[];
  const transfers = (await db.execute(sql`
    SELECT e.event_type, e.memo, e.tx_signature, to_char(e.occurred_at, 'MM-DD HH24:MI') at,
           (SELECT l.amount_usd::float FROM ledger_legs l WHERE l.event_id = e.id AND l.account = 'cash:sol') usd,
           (SELECT l.amount_native::float FROM ledger_legs l WHERE l.event_id = e.id AND l.account = 'cash:sol') sol
    FROM ledger_events e
    WHERE e.book = 'live' AND e.event_type LIKE 'transfer%'
    ORDER BY e.occurred_at DESC LIMIT 10`)) as unknown as {
    event_type: string; memo: string; tx_signature: string | null; at: string; usd: number | null; sol: number | null;
  }[];
  return NextResponse.json({
    address: w.publicKey.toBase58(),
    sol: lamports != null ? lamports / 1e9 : null,
    solUsd,
    usd: lamports != null && solUsd != null ? (lamports / 1e9) * solUsd : null,
    stale, // true when the figure is the reconciler's last proven read, not a live RPC read
    reconAt: recon[0]?.value?.at ?? null,
    sendRequest: sendReq[0]?.value ?? null,
    transfers,
  });
}
