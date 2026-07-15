import type { SafetyCheckResult } from "../types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const PROBE_LAMPORTS = 10_000_000; // 0.01 SOL probe size

interface JupiterQuote {
  outAmount: string;
  priceImpactPct: string;
  routePlan?: unknown[];
}

// `inconclusive` = we could NOT get a definitive answer from Jupiter (it was
// unreachable / timed out / 5xx). That is NOT evidence of a honeypot — it must
// never hard-trap the candidate, or a Jupiter outage silently halts the whole
// pipeline (exactly what stalled trading). A plain `error` (Jupiter answered but
// there's no route) IS a definitive answer used to detect the buy-ok/sell-bad
// asymmetry that defines a honeypot.
async function getQuote(
  baseUrl: string,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<JupiterQuote | { error: string; inconclusive: boolean }> {
  const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  } catch (err) {
    // network blocked / reset / timeout — Jupiter is unreachable, not a verdict
    return { error: `unreachable: ${err instanceof Error ? err.message : String(err)}`, inconclusive: true };
  }
  if (res.status >= 500) return { error: `HTTP ${res.status}`, inconclusive: true }; // Jupiter erroring, inconclusive
  const body = (await res.json().catch(() => null)) as
    | (JupiterQuote & { error?: string; errorCode?: string })
    | null;
  if (!res.ok || !body || body.error || !body.outAmount) {
    // Jupiter answered: no route. Definitive (for detecting sell-side asymmetry).
    return { error: body?.error ?? body?.errorCode ?? `HTTP ${res.status}`, inconclusive: false };
  }
  return body;
}

/**
 * Check 4: honeypot probe — a 0.01 SOL buy quote followed by a sell quote
 * of the resulting tokens must both route, each with sane price impact,
 * and the round trip must return at least SAFETY_MIN_ROUNDTRIP_RATIO of
 * the SOL put in. A token you can buy but not sell fails here.
 *
 * A honeypot is specifically buy-OK / sell-BAD. If we can't even probe (Jupiter
 * unreachable, or the token isn't routable on Jupiter yet — common for fresh
 * bonding-curve pools), the result is INCONCLUSIVE, not a trap: the pipeline
 * soft-flags and sizes down rather than hard-rejecting. Only a real buy-ok /
 * sell-fails asymmetry (Jupiter reachable, sell has no route or a ruinous ratio)
 * is a confirmed honeypot.
 */
export async function checkHoneypot(
  jupiterBaseUrl: string,
  mint: string,
  opts: { maxPriceImpactPct: number; minRoundtripRatio: number },
): Promise<SafetyCheckResult> {
  const buy = await getQuote(jupiterBaseUrl, WSOL_MINT, mint, String(PROBE_LAMPORTS));
  if ("error" in buy) {
    // Can't even buy-quote → can't probe. Whether Jupiter is down or the token
    // isn't indexed yet, this is NOT a proven honeypot (which needs a working buy
    // and a failing sell). Inconclusive → soft-flag, never trap.
    return {
      checkName: "honeypot_probe",
      passed: false,
      evidence: { stage: "buy_quote", error: buy.error, inconclusive: true },
    };
  }

  const sell = await getQuote(jupiterBaseUrl, mint, WSOL_MINT, buy.outAmount);
  if ("error" in sell) {
    // Buy routed but sell didn't. If Jupiter was unreachable mid-probe → inconclusive;
    // if Jupiter answered "no sell route" → that's the honeypot signature → trap.
    return {
      checkName: "honeypot_probe",
      passed: false,
      evidence: { stage: "sell_quote", error: sell.error, inconclusive: sell.inconclusive, buyImpactPct: buy.priceImpactPct },
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
