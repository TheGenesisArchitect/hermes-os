/** Minimal Solana JSON-RPC client — enough for the safety pipeline without pulling in web3.js. */

let rpcId = 0;

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

export interface ParsedMintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
}

export async function getMintInfo(rpcUrl: string, mint: string): Promise<ParsedMintInfo | null> {
  const result = await rpcCall<{
    value: { data?: { parsed?: { info?: Record<string, unknown>; type?: string } } } | null;
  }>(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const info = result?.value?.data?.parsed?.info;
  if (!info) return null;
  return {
    mintAuthority: (info.mintAuthority as string | undefined) ?? null,
    freezeAuthority: (info.freezeAuthority as string | undefined) ?? null,
    supply: String(info.supply ?? "0"),
    decimals: Number(info.decimals ?? 0),
  };
}

export interface LargestAccount {
  address: string;
  amount: string;
  uiAmount: number | null;
}

export async function getTokenLargestAccounts(
  rpcUrl: string,
  mint: string,
): Promise<LargestAccount[]> {
  const result = await rpcCall<{ value: LargestAccount[] }>(rpcUrl, "getTokenLargestAccounts", [
    mint,
  ]);
  return result?.value ?? [];
}

/** Fetch the owner wallet of each token account (jsonParsed batch). */
export async function getTokenAccountOwners(
  rpcUrl: string,
  tokenAccounts: string[],
): Promise<Map<string, string>> {
  if (tokenAccounts.length === 0) return new Map();
  const result = await rpcCall<{
    value: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null>;
  }>(rpcUrl, "getMultipleAccounts", [tokenAccounts, { encoding: "jsonParsed" }]);
  const owners = new Map<string, string>();
  result?.value?.forEach((acct, i) => {
    const owner = acct?.data?.parsed?.info?.owner;
    const address = tokenAccounts[i];
    if (owner && address) owners.set(address, owner);
  });
  return owners;
}
