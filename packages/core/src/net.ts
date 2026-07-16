import { spawn } from "node:child_process";

/**
 * fetch() that survives this host's upstream SNI-DPI filter.
 *
 * The filter resets TLS to specific crypto-data hosts (geckoterminal.com,
 * *.jup.ag, birdeye.so) by matching the SNI in the ClientHello. GoodbyeDPI
 * (-5) defeats it for curl/schannel, but NOT for Node's undici — undici's
 * ClientHello segments differently and still gets ECONNRESET. curl gets
 * through, so on a connection-level failure we retry the request via curl.
 *
 * Hosts that already work natively (DexScreener, RugCheck, PumpPortal) never
 * hit the fallback. Once a host is seen to reset, we skip the doomed native
 * attempt on subsequent calls (matters for the trader's per-cycle price read).
 *
 * Requires GoodbyeDPI running for the curl path to reach the filtered hosts;
 * if it isn't, both paths fail and the caller's existing fallback (DexScreener
 * marks / ingest) takes over — exactly as before.
 */

const resetHosts = new Set<string>();

interface ResilientOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
}

export async function resilientFetch(url: string, opts: ResilientOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    /* malformed URL — let native fetch surface it */
  }

  if (!resetHosts.has(host)) {
    try {
      return await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (!isConnectionReset(err)) throw err; // a real timeout/abort — don't mask it with curl
      if (host) resetHosts.add(host); // filtered host: skip the doomed native attempt next time
    }
  }
  return curlFetch(url, opts.headers, timeoutMs, opts.method, opts.body);
}

/** A TLS/TCP reset (the SNI-filter signature) — not a deliberate abort or DNS error. */
function isConnectionReset(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "UND_ERR_SOCKET") return true;
  // undici wraps the reset as a generic TypeError "fetch failed"
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function curlFetch(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
  method?: string,
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "-w", "\n%{http_code}"];
    for (const [k, v] of Object.entries(headers ?? {})) args.push("-H", `${k}: ${v}`);
    if (method && method.toUpperCase() !== "GET") args.push("-X", method.toUpperCase());
    // spawn passes args verbatim (no shell), so a JSON body needs no escaping;
    // --data-binary preserves it exactly rather than stripping newlines like -d.
    if (body != null) args.push("--data-binary", body);
    args.push(url);
    const child = spawn("curl", args, { windowsHide: true });
    let out = "";
    let errText = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errText += d));
    child.on("error", (e) => reject(new Error(`curl spawn failed: ${e.message}`)));
    child.on("close", () => {
      const nl = out.lastIndexOf("\n");
      const body = nl >= 0 ? out.slice(0, nl) : "";
      const status = nl >= 0 ? Number.parseInt(out.slice(nl + 1).trim(), 10) : 0;
      if (!status) return reject(new Error(`curl no status (${errText.trim() || "connection failed"})`));
      resolve(new Response(body, { status }));
    });
  });
}
