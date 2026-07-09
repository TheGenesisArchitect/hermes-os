import type { SafetyCheckResult } from "../types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const PROBE_LAMPORTS = 10_000_000; // 0.01 SOL probe size

interface JupiterQuote {
  outAmount: string;
  priceImpactPct: string;
  routePlan?: unknown[];
}

async function getQuote(
  baseUrl: string,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<JupiterQuote | { error: string }> {
  const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as
    | (JupiterQuote & { error?: string; errorCode?: string })
    | null;
  if (!res.ok || !body || body.error || !body.outAmount) {
    return { error: body?.error ?? body?.errorCode ?? `HTTP ${res.status}` };
  }
  return body;
}

/**
 * Check 4: honeypot probe — a 0.01 SOL buy quote followed by a sell quote
 * of the resulting tokens must both route, each with sane price impact,
 * and the round trip must return at least SAFETY_MIN_ROUNDTRIP_RATIO of
 * the SOL put in. A token you can buy but not sell fails here.
 */
export async function checkHoneypot(
  jupiterBaseUrl: string,
  mint: string,
  opts: { maxPriceImpactPct: number; minRoundtripRatio: number },
): Promise<SafetyCheckResult> {
  const buy = await getQuote(jupiterBaseUrl, WSOL_MINT, mint, String(PROBE_LAMPORTS));
  if ("error" in buy) {
    return {
      checkName: "honeypot_probe",
      passed: false,
      evidence: { stage: "buy_quote", error: buy.error, retryable: true },
    };
  }

  const sell = await getQuote(jupiterBaseUrl, mint, WSOL_MINT, buy.outAmount);
  if ("error" in sell) {
    return {
      checkName: "honeypot_probe",
      passed: false,
      evidence: { stage: "sell_quote", error: sell.error, buyImpactPct: buy.priceImpactPct },
    };
  }

  const buyImpact = Math.abs(Number(buy.priceImpactPct)) * 100;
  const sellImpact = Math.abs(Number(sell.priceImpactPct)) * 100;
  const roundtripRatio = Number(sell.outAmount) / PROBE_LAMPORTS;
  const passed =
    buyImpact <= opts.maxPriceImpactPct &&
    sellImpact <= opts.maxPriceImpactPct &&
    roundtripRatio >= opts.minRoundtripRatio;

  return {
    checkName: "honeypot_probe",
    passed,
    evidence: {
      buyImpactPct: Number(buyImpact.toFixed(2)),
      sellImpactPct: Number(sellImpact.toFixed(2)),
      roundtripRatio: Number(roundtripRatio.toFixed(4)),
      thresholds: opts,
      probeSol: PROBE_LAMPORTS / 1e9,
    },
  };
}
