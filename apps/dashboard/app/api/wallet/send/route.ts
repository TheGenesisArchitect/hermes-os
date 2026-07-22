// WALLET SEND — validate and QUEUE an operator send; the trader executes it.
//
// The dashboard never touches RPC for money movement: fresh Node processes on
// this host get ECONNRESET from the public RPCs, and more fundamentally the
// trader is the single money-mover — every SOL movement (trade or transfer)
// goes through its rpcPool, its ledger booking, and its audit trail. This
// route's job is the operator-facing rails:
//  · destination must parse as a Solana address, and `confirm` must echo its
//    last 4 characters — the UI forces the operator to read what they typed
//  · amount is sanity-capped against the reconciler's last proven balance
//    (the trader re-validates against a live chain read before signing)
//  · one request in flight at a time — no queued stack of forgotten sends
import { NextResponse } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { sql } from "drizzle-orm";
import { db } from "@hermes/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEE_RESERVE_SOL = 0.01;

function walletAddress(): string | null {
  const raw = (process.env.TRADER_WALLET_SECRET_KEY ?? "").trim();
  if (!raw) return null;
  try {
    const secret = bs58.decode(raw);
    return secret.length === 64 ? Keypair.fromSecretKey(secret).publicKey.toBase58() : null;
  } catch {
    return null;
  }
}

async function audit(action: string, details: Record<string, unknown>): Promise<void> {
  await db
    .execute(sql`INSERT INTO audit_log (actor, action, details) VALUES ('user', ${action}, ${JSON.stringify(details)}::jsonb)`)
    .catch(() => {});
}

export async function POST(req: Request) {
  const self = walletAddress();
  if (!self) return NextResponse.json({ error: "no wallet key configured" }, { status: 503 });
  let body: { to?: string; amountSol?: number; confirm?: string; memo?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  let dest: PublicKey;
  try {
    dest = new PublicKey(String(body.to ?? ""));
  } catch {
    return NextResponse.json({ error: "destination is not a valid Solana address" }, { status: 400 });
  }
  const amt = Number(body.amountSol);
  if (!Number.isFinite(amt) || amt <= 0)
    return NextResponse.json({ error: "amount must be a positive SOL value" }, { status: 400 });
  if (String(body.confirm ?? "") !== dest.toBase58().slice(-4)) {
    await audit("wallet_send_refused", { to: dest.toBase58(), amountSol: amt, reason: "confirm mismatch" });
    return NextResponse.json({ error: "confirmation must match the last 4 characters of the destination" }, { status: 400 });
  }
  if (dest.toBase58() === self) return NextResponse.json({ error: "destination is this wallet" }, { status: 400 });

  // Sanity cap against the last proven balance; the trader re-checks live.
  const recon = (await db.execute(sql`SELECT value FROM config WHERE key = 'ledger_recon_status'`)) as unknown as {
    value: { chainSol?: number };
  }[];
  const chainSol = recon[0]?.value?.chainSol;
  if (chainSol != null && amt > chainSol - FEE_RESERVE_SOL) {
    await audit("wallet_send_refused", { to: dest.toBase58(), amountSol: amt, chainSol, reason: "exceeds last proven balance minus fee reserve" });
    return NextResponse.json(
      { error: `amount exceeds sendable balance (~${Math.max(0, chainSol - FEE_RESERVE_SOL).toFixed(6)} SOL after the ${FEE_RESERVE_SOL} SOL fee reserve)` },
      { status: 400 },
    );
  }

  // One request in flight at a time — refuse while pending/processing.
  const existing = (await db.execute(sql`SELECT value FROM config WHERE key = 'wallet_send_request'`)) as unknown as {
    value: { status?: string };
  }[];
  const st = existing[0]?.value?.status;
  if (st === "pending" || st === "processing")
    return NextResponse.json({ error: "a send is already in flight — wait for it to settle" }, { status: 409 });

  const id = `send-${Date.now()}`;
  const request = {
    id,
    to: dest.toBase58(),
    amountSol: amt,
    memo: (body.memo ?? "").trim() || null,
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  await db.execute(sql`
    INSERT INTO config (key, value) VALUES ('wallet_send_request', ${JSON.stringify(request)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(request)}::jsonb, updated_at = now()`);
  await audit("wallet_send_queued", { id, to: dest.toBase58(), amountSol: amt });
  return NextResponse.json({ queued: true, id });
}
