"use client";

// WALLET — send, receive, and connect for the live wallet. Receive is the
// address + QR (any wallet can pay it); Send signs server-side behind a
// type-to-confirm rail; Connect uses an injected provider (Phantom/Solflare)
// to deposit from a browser wallet without ever touching our key.
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Panel } from "@/components/ui/Drawer";

interface WalletInfo {
  address: string;
  sol: number | null;
  solUsd: number | null;
  usd: number | null;
  transfers: { event_type: string; memo: string; tx_signature: string | null; at: string; usd: number | null; sol: number | null }[];
}

interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
}

function injected(): InjectedProvider | null {
  const w = window as unknown as { phantom?: { solana?: InjectedProvider }; solana?: InjectedProvider };
  return w.phantom?.solana ?? w.solana ?? null;
}

const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;

export function WalletPanel() {
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [tab, setTab] = useState<"receive" | "send" | "connect">("receive");
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  // send form
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // connect
  const [connected, setConnected] = useState<string | null>(null);
  const [depositAmt, setDepositAmt] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/wallet", { cache: "no-store" });
      if (r.ok) setInfo(await r.json());
    } catch {
      /* transient — panel keeps last reading */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (info?.address && qrRef.current && tab === "receive")
      void QRCode.toCanvas(qrRef.current, `solana:${info.address}`, { width: 148, margin: 1 });
  }, [info?.address, tab]);

  const copy = async () => {
    if (!info?.address) return;
    await navigator.clipboard.writeText(info.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/wallet/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: to.trim(), amountSol: Number(amount), confirm: confirm.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        setResult({ ok: false, text: j.error ?? "send failed" });
        return;
      }
      // Queued — the trader executes it within one manage tick. Poll until it settles.
      setResult({ ok: true, text: "Queued — the trader is signing and confirming on-chain…" });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 3_000));
        const ir = await fetch("/api/wallet", { cache: "no-store" });
        if (!ir.ok) continue;
        const inf: WalletInfo & { sendRequest?: { id?: string; status?: string; signature?: string; usd?: number; error?: string } } = await ir.json();
        setInfo(inf);
        const sr = inf.sendRequest;
        if (!sr || sr.id !== j.id) continue;
        if (sr.status === "sent") {
          setResult({ ok: true, text: `Sent ${Number(amount)} SOL${sr.usd ? ` (≈${money(sr.usd)})` : ""} — tx ${String(sr.signature).slice(0, 8)}… confirmed` });
          setTo(""); setAmount(""); setConfirm("");
          return;
        }
        if (sr.status === "failed") {
          setResult({ ok: false, text: sr.error ?? "send failed" });
          return;
        }
      }
      setResult({ ok: false, text: "still settling — check the transfer history in a minute" });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "send failed" });
    } finally {
      setBusy(false);
    }
  };

  const connectWallet = async () => {
    const p = injected();
    if (!p) {
      setResult({ ok: false, text: "No browser wallet found — install Phantom or Solflare, or use the Receive address." });
      return;
    }
    try {
      const res = await p.connect();
      setConnected(res.publicKey.toBase58());
    } catch {
      /* user dismissed */
    }
  };

  const depositFromConnected = async () => {
    const p = injected();
    if (!p || !connected || !info?.address) return;
    setBusy(true);
    setResult(null);
    try {
      const web3 = await import("@solana/web3.js");
      // Build client-side: transfer from the connected wallet to the hermes address.
      const conn = new web3.Connection("https://solana-rpc.publicnode.com", "confirmed");
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: new web3.PublicKey(connected),
          toPubkey: new web3.PublicKey(info.address),
          lamports: Math.round(Number(depositAmt) * web3.LAMPORTS_PER_SOL),
        }),
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer = new web3.PublicKey(connected);
      const { signature } = await p.signAndSendTransaction(tx);
      setResult({ ok: true, text: `Deposit sent — tx ${signature.slice(0, 8)}… (the reconciler books it within one cycle)` });
      setDepositAmt("");
      setTimeout(() => void refresh(), 8_000);
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "deposit failed" });
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (key: typeof tab, label: string) => (
    <button
      onClick={() => { setTab(key); setResult(null); }}
      className="px-3 py-1 text-xs font-medium"
      style={{
        background: tab === key ? "var(--surface-1)" : "transparent",
        color: tab === key ? "var(--text-primary)" : "var(--text-muted)",
        borderBottom: tab === key ? "2px solid var(--series-1)" : "2px solid transparent",
      }}
    >
      {label}
    </button>
  );

  const inputStyle = {
    background: "var(--page)",
    border: "1px solid var(--gridline)",
    color: "var(--text-primary)",
  } as const;

  const transfersTable = info?.transfers?.length ? (
    <table className="w-full text-[11px]">
      <tbody>
        {info.transfers.map((t, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--gridline)" }}>
            <td className="tabular py-1 pr-2" style={{ color: "var(--text-muted)", width: 84 }}>{t.at}</td>
            <td className="py-1 pr-2" style={{ color: "var(--text-secondary)" }}>{t.event_type === "transfer.in" ? "↓ in" : "↑ out"}</td>
            <td className="tabular py-1 pr-2 text-right" style={{ color: (t.usd ?? 0) >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
              {t.usd != null ? money(t.usd) : "—"}{t.sol != null ? ` (${Math.abs(t.sol).toFixed(4)} SOL)` : ""}
            </td>
            <td className="max-w-[240px] truncate py-1 text-[10px]" style={{ color: "var(--text-muted)" }} title={t.memo}>
              {t.memo}{t.tx_signature ? " · tx ✓" : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>No transfers recorded yet.</p>
  );

  return (
    <Panel
      title="Wallet"
      badge={<span className="tabular rounded px-1.5 py-px text-[10px]" style={{ border: "1px solid var(--status-serious)", color: "var(--status-serious)" }}>◆ real capital</span>}
      accent="var(--status-serious)"
      storageKey="wallet-panel"
      drawerTitle="Transfers"
      drawerSubtitle="Every deposit and withdrawal as an immutable journal event, chain-verified by the reconciler"
      expandLabel="History"
      drawer={
        <div className="space-y-3">
          {transfersTable}
          <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Sends sign server-side behind a type-to-confirm rail and keep a 0.01 SOL fee reserve; each confirmed
            transfer books as <span className="mono">transfer.out</span> with the tx signature as its idempotency key.
            Deposits are detected on-chain and booked as <span className="mono">transfer.in</span> by the reconciler.
          </p>
        </div>
      }
    >
      {/* KPI row */}
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="flex-1 rounded-md p-3" style={{ background: "var(--page)", border: "1px solid var(--gridline)", minWidth: 150 }}>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Balance</div>
          <div className="tabular mt-1 text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
            {info?.sol != null ? `${info.sol.toFixed(4)} SOL` : "—"}
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>
            {info?.usd != null ? `≈ ${money(info.usd)} · ◆ real capital` : "chain read pending"}
          </div>
        </div>
        <div className="flex-[2] rounded-md p-3" style={{ background: "var(--page)", border: "1px solid var(--gridline)", minWidth: 220 }}>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Address</div>
          <div className="mono mt-1 break-all text-[11px]" style={{ color: "var(--text-primary)" }}>{info?.address ?? "—"}</div>
          <button onClick={copy} className="mt-1 rounded px-2 py-0.5 text-[10px]" style={{ border: "1px solid var(--gridline)", color: copied ? "var(--status-good)" : "var(--text-secondary)" }}>
            {copied ? "✓ copied" : "copy"}
          </button>
        </div>
      </div>

      <div className="mb-3 flex" style={{ borderBottom: "1px solid var(--gridline)" }}>
        {tabBtn("receive", "Receive")}
        {tabBtn("send", "Send")}
        {tabBtn("connect", "Connect wallet")}
      </div>

      {tab === "receive" ? (
        <div className="flex flex-wrap items-center gap-4">
          <canvas ref={qrRef} className="rounded-md" style={{ border: "1px solid var(--gridline)" }} />
          <div className="min-w-[220px] flex-1 text-[11px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Send SOL from any wallet or exchange to the address above — scan the QR or copy it. Deposits are detected
            on-chain by the reconciler and booked as <span className="mono">transfer.in</span> within one cycle
            (~5&nbsp;min), then join the trading bankroll automatically.
          </div>
        </div>
      ) : null}

      {tab === "send" ? (
        <div className="max-w-md space-y-2">
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Destination address"
            className="mono w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} />
          <div className="flex gap-2">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (SOL)" inputMode="decimal"
              className="tabular w-32 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} />
            <div className="tabular self-center text-[10px]" style={{ color: "var(--text-muted)" }}>
              {amount && info?.solUsd ? `≈ ${money(Number(amount) * info.solUsd)}` : ""}
            </div>
          </div>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type the LAST 4 characters of the destination to confirm"
            className="mono w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} />
          <button onClick={send} disabled={busy || !to || !amount || !confirm}
            className="rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            style={{ background: "var(--status-serious)", color: "#fff" }}>
            {busy ? "Sending…" : "Send SOL"}
          </button>
          <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Queued to the trader — the single money-mover — which signs, confirms on-chain, journals the transfer as
            <span className="mono"> transfer.out</span>, and audits it. A 0.01 SOL reserve is always kept for fees.
          </p>
        </div>
      ) : null}

      {tab === "connect" ? (
        <div className="max-w-md space-y-2">
          {connected ? (
            <>
              <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Connected: <span className="mono" style={{ color: "var(--text-primary)" }}>{connected.slice(0, 4)}…{connected.slice(-4)}</span>
              </div>
              <div className="flex gap-2">
                <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} placeholder="Deposit (SOL)" inputMode="decimal"
                  className="tabular w-32 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} />
                <button onClick={depositFromConnected} disabled={busy || !depositAmt}
                  className="rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  style={{ background: "var(--series-1)", color: "#fff" }}>
                  {busy ? "Waiting for wallet…" : "Deposit to Hermes"}
                </button>
              </div>
            </>
          ) : (
            <button onClick={connectWallet} className="rounded-md px-3 py-1.5 text-xs font-medium"
              style={{ border: "1px solid var(--gridline)", color: "var(--text-primary)" }}>
              Connect browser wallet (Phantom / Solflare)
            </button>
          )}
          <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            The browser wallet signs its own transaction — Hermes never sees its key. Deposits are booked by the
            reconciler like any other inbound transfer.
          </p>
        </div>
      ) : null}

      {result ? (
        <div className="mt-2 rounded-md px-3 py-2 text-[11px]"
          style={{ border: `1px solid ${result.ok ? "var(--status-good)" : "var(--status-critical)"}`, color: result.ok ? "var(--status-good)" : "var(--status-critical)" }}>
          {result.text}
        </div>
      ) : null}

    </Panel>
  );
}
