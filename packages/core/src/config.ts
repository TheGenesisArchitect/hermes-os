import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgres://hermes:hermes@localhost:5432/hermes"),
  HELIUS_API_KEY: z.string().optional().default(""),
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  BIRDEYE_API_KEY: z.string().optional().default(""),
  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/swap/v1"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  SCOUT_POLL_MS: z.coerce.number().default(45_000),
  SCOUT_MIN_LIQUIDITY_USD: z.coerce.number().default(10_000),
  SAFETY_TOP10_MAX_PCT: z.coerce.number().default(25),
  SAFETY_SINGLE_HOLDER_MAX_PCT: z.coerce.number().default(5),
  SAFETY_MAX_PRICE_IMPACT_PCT: z.coerce.number().default(15),
  SAFETY_MIN_ROUNDTRIP_RATIO: z.coerce.number().default(0.6),

  LIVE_TRADING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  LIVE_MAX_POSITION_USD: z.coerce.number().default(25),
  LIVE_MAX_CONCURRENT: z.coerce.number().default(2),
  LIVE_DAILY_LOSS_CAP_USD: z.coerce.number().default(50),
});

export type HermesConfig = z.infer<typeof envSchema> & { rpcUrl: string };

let cached: HermesConfig | null = null;

export function loadConfig(): HermesConfig {
  if (cached) return cached;
  const env = envSchema.parse(process.env);
  const rpcUrl = env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
    : env.SOLANA_RPC_URL;
  cached = { ...env, rpcUrl };
  return cached;
}
