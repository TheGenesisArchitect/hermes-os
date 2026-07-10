import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgres://hermes:hermes@localhost:5433/hermes"),
  HELIUS_API_KEY: z.string().optional().default(""),
  SOLANA_RPC_URL: z.string().default("https://solana-rpc.publicnode.com"),
  BIRDEYE_API_KEY: z.string().optional().default(""),
  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/swap/v1"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  SCOUT_POLL_MS: z.coerce.number().default(45_000),
  SCOUT_MIN_LIQUIDITY_USD: z.coerce.number().default(10_000),
  SAFETY_TOP10_MAX_PCT: z.coerce.number().default(25),
  SAFETY_SINGLE_HOLDER_MAX_PCT: z.coerce.number().default(5),
  SAFETY_MAX_PRICE_IMPACT_PCT: z.coerce.number().default(15),
  SAFETY_MIN_ROUNDTRIP_RATIO: z.coerce.number().default(0.6),

  SIGNAL_MIN_SCORE: z.coerce.number().default(55),
  SIGNAL_MAX_AGE_MIN: z.coerce.number().default(20),
  PAPER_BANKROLL_USD: z.coerce.number().default(1_000),
  PAPER_POSITION_USD: z.coerce.number().default(100),
  TRADER_POLL_MS: z.coerce.number().default(20_000),
  TP_MULTIPLIER: z.coerce.number().default(2),
  TP_SELL_FRACTION: z.coerce.number().default(0.5),
  TRAIL_DROP_PCT: z.coerce.number().default(35),
  HARD_STOP_PCT: z.coerce.number().default(40),
  MAX_HOLD_HOURS: z.coerce.number().default(6),
  PNL_SNAPSHOT_MS: z.coerce.number().default(300_000),

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
