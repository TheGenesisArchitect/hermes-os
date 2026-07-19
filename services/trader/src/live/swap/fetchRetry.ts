/**
 * swapFetch — fetch with retry for the swap providers. This host's DPI filter
 * intermittently mangles Node's fetch (undici) to external hosts, surfacing as a
 * one-off connection reset or an injected 400/403 even when the endpoint is
 * healthy (curl gets through cleanly; a retry a moment later usually succeeds).
 * A single blip must NOT fail a live trade, so we retry a few times with a short
 * backoff. The final attempt's result (success or the real error) is returned.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function swapFetch(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastRes: Response | null = null;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      // Transient-blip signatures on this host: injected 400/403 or a 5xx.
      if (res.status === 400 || res.status === 403 || res.status >= 500) {
        lastRes = res;
        if (i < attempts - 1) await sleep(150 * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(150 * (i + 1));
    }
  }
  if (lastRes) return lastRes; // real HTTP error after retries — let the caller read it
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
