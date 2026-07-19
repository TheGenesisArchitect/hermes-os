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

const FLUXBEAM_DEFAULT = "https://api.fluxbeam.xyz/v1";

/** Fluxbeam quote (independent route). Shape: { quote: { outAmount } }. Used as a
 *  honeypot-probe FALLBACK when Jupiter is unreachable, so sell-routability can
 *  still be verified during a Jupiter outage — a token that round-trips on
 *  Fluxbeam is provably sellable. */
async function getFluxQuote(
  baseUrl: string,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<{ outAmount: string } | { error: string; inconclusive: boolean }> {
  const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  } catch (err) {
    return { error: `fluxbeam unreachable: ${err instanceof Error ? err.message : String(err)}`, inconclusive: true };
  }
  if (res.status >= 500) return { error: `HTTP ${res.status}`, inconclusive: true };
  const body = (await res.json().catch(() => null)) as { quote?: { outAmount?: string }; error?: string } | null;
  if (!res.ok || !body?.quote?.outAmount) return { error: body?.error ?? `HTTP ${res.status}`, inconclusive: false };
  return { outAmount: String(body.quote.outAmount) };
}

/**
 * Check 4: honeypot probe — a 0.01 SOL buy quote followed by a sell quote of the
 * resulting tokens must both route and the round trip must return at least
 * minRoundtripRatio of the SOL put in. A token you can buy but not sell fails.
 *
 * Tried on TWO independent routes: Jupiter first (with price-impact checks), and
 * if Jupiter is unreachable, FLUXBEAM (round-trip ratio only — Fluxbeam gives no
 * impact %). This is what lets live keep verifying + trading during a Jupiter
 * outage. Only a real buy-ok / sell-fails asymmetry on a REACHABLE route is a
 * confirmed honeypot (trap); a token neither route can quote stays INCONCLUSIVE
 * (soft-flag, never trap).
 */
export async function checkHoneypot(
  jupiterBaseUrl: string,
  mint: string,
  opts: { maxPriceImpactPct: number; minRoundtripRatio: number },
  fluxbeamBaseUrl: string = FLUXBEAM_DEFAULT,
): Promise<SafetyCheckResult> {
  // ── Route 1: Jupiter (with price-impact checks) ──
  const buy = await getQuote(jupiterBaseUrl, WSOL_MINT, mint, String(PROBE_LAMPORTS));
  let jupiterInconclusive = false;
  if ("error" in buy) {
    jupiterInconclusive = true; // couldn't buy-quote on Jupiter (down or unindexed) → try Fluxbeam
  } else {
    const sell = await getQuote(jupiterBaseUrl, mint, WSOL_MINT, buy.outAmount);
    if ("error" in sell) {
      if (!sell.inconclusive) {
        // Jupiter reachable, buy-ok, sell-NO-route → the honeypot signature → trap.
        return {
          checkName: "honeypot_probe",
          passed: false,
          evidence: { stage: "sell_quote", route: "jupiter", error: sell.error, inconclusive: false, buyImpactPct: buy.priceImpactPct },
        };
      }
      jupiterInconclusive = true; // Jupiter dropped mid-probe → try Fluxbeam
    } else {
      const buyImpact = Math.abs(Number(buy.priceImpactPct)) * 100;
      const sellImpact = Math.abs(Number(sell.priceImpactPct)) * 100;
      const roundtripRatio = Number(sell.outAmount) / PROBE_LAMPORTS;
      const passed =
        buyImpact <= opts.maxPriceImpactPct && sellImpact <= opts.maxPriceImpactPct && roundtripRatio >= opts.minRoundtripRatio;
      return {
        checkName: "honeypot_probe",
        passed,
        evidence: {
          route: "jupiter",
          buyImpactPct: Number(buyImpact.toFixed(2)),
          sellImpactPct: Number(sellImpact.toFixed(2)),
          roundtripRatio: Number(roundtripRatio.toFixed(4)),
          thresholds: opts,
          probeSol: PROBE_LAMPORTS / 1e9,
        },
      };
    }
  }

  // ── Route 2: Fluxbeam fallback (when Jupiter is inconclusive) ──
  if (jupiterInconclusive && fluxbeamBaseUrl) {
    const fbuy = await getFluxQuote(fluxbeamBaseUrl, WSOL_MINT, mint, String(PROBE_LAMPORTS));
    if (!("error" in fbuy)) {
      const fsell = await getFluxQuote(fluxbeamBaseUrl, mint, WSOL_MINT, fbuy.outAmount);
      if (!("error" in fsell)) {
        const roundtripRatio = Number(fsell.outAmount) / PROBE_LAMPORTS;
        const passed = roundtripRatio >= opts.minRoundtripRatio; // Fluxbeam has no impact %; ratio is the honeypot signal
        return {
          checkName: "honeypot_probe",
          passed,
          evidence: { route: "fluxbeam", roundtripRatio: Number(roundtripRatio.toFixed(4)), thresholds: opts, probeSol: PROBE_LAMPORTS / 1e9 },
        };
      }
      if (!fsell.inconclusive) {
        // Fluxbeam buy-ok, sell-NO-route → honeypot on the reachable route → trap.
        return {
          checkName: "honeypot_probe",
          passed: false,
          evidence: { stage: "sell_quote", route: "fluxbeam", error: fsell.error, inconclusive: false },
        };
      }
    }
  }

  // Neither route could verify → inconclusive (soft-flag, never trap).
  return {
    checkName: "honeypot_probe",
    passed: false,
    evidence: { stage: "buy_quote", route: "none", inconclusive: true },
  };
}
