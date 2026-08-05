export { loadConfig, type HermesConfig } from "./config.js";
export {
  OVERRIDE_KNOBS,
  EMPTY_OVERRIDES,
  ADAPTIVE_MIN_N,
  clampKnob,
  resolveOverrides,
  computeAdaptivePolicy,
  type OverrideKey,
  type OverrideGroup,
  type OverrideKnob,
  type OverrideSource,
  type AutoMode,
  type RuntimeOverrides,
  type ResolvedKnob,
  type ResolvedOverrides,
  type RegimeStats,
  type RegimeState,
  type AdaptivePolicy,
} from "./overrides.js";
export type { TokenCandidate, SafetyCheckResult, SafetyVerdict } from "./types.js";
export { runSafetyPipeline } from "./safety/pipeline.js";
export { checkMintAuthority } from "./safety/mintAuthority.js";
export { checkRugcheck } from "./safety/rugcheck.js";
export { checkHolderConcentration } from "./safety/holders.js";
export { checkHoneypot } from "./safety/honeypot.js";
export * as rpc from "./rpc.js";
export { fetchTokenMarket, fetchTokenMarkets, type TokenMarket } from "./market/dexscreener.js";
export { fetchJupiterPrice, fetchJupiterPrices } from "./market/jupiter.js";
export { convexSlippagePct } from "./market/slippage.js";
// THE MARKET TRUTH ENGINE — one canonical market state for paper, live,
// replay and console (tech spec v2). The look-ahead invariant lives here.
export {
  recognizable, armable, highWaterCrossing, canonicalMark, truthAgreement,
  SOURCE_CONFIDENCE, CONFIDENCE_MIN, TRUSTED_MIN_LIQ_USD,
  type TruthTick, type TruthSource,
} from "./market/truth.js";
export { resilientFetch } from "./net.js";
export { computeScore, type ScoreBreakdown } from "./scoring/score.js";
export { scoreNarrative, type NarrativeScore } from "./scoring/narrative.js";
export {
  classify,
  tickFrom,
  DEFAULT_CLASSIFIER,
  type Tick,
  type ManagementCall,
  type ManagementFeature,
  type ClassifierConfig,
  type Regime,
  type Action,
} from "./management/classifier.js";
export {
  tradeDna,
  harvestClock,
  MOONSHOT_HORIZON_SEC,
  CLOCK_DECAY_START_SEC,
  type DnaState,
  type TradeDna,
  type HarvestClockView,
} from "./management/dna.js";
export {
  evaluateEntryTrigger,
  entryTriggerConfigFrom,
  type EntryTrigger,
  type EntryTriggerConfig,
} from "./management/entryTrigger.js";
export {
  routeSignature,
  profileOf,
  convictionOf,
  isMoon,
  sizeFraction,
  signatureExitOverrides,
  withLearned,
  SIGNATURE_PROFILES,
  type LearnedProfile,
  type Conviction,
  type Signature,
  type SignatureInputs,
  type SignatureProfile,
} from "./management/signature.js";
export {
  runForecast,
  type ForecastOptions,
  type ForecastResult,
  type ForecastBucket,
} from "./forecast.js";
export {
  scoreRugProb,
  rugFeatureVector,
  RUG_WEIGHTS,
  RUG_BIAS,
  RUG_FEATURE_NAMES,
  type RugModelInput,
} from "./management/rugModel.js";
export {
  walletEdgeFrom,
  isWinnerRep,
  isRugRep,
  WALLET_MIN_SAMPLE,
  type WalletRep,
  type WalletEdge,
} from "./management/walletReputation.js";
export {
  scoreConviction,
  convictionBand,
  type ConvictionInput,
  type ConvictionWeights,
} from "./management/conviction.js";
export { canonicalVenue } from "./market/venue.js";
export { ollamaJson, ollamaUp, OLLAMA_MODEL } from "./llm/ollama.js";
export { llmJson, llmText, llmUp, quantProvider, GROQ_MODEL } from "./llm/quant.js";
export {
  FRONTIER_FEEDS,
  fetchFeed,
  classifyFrontier,
  synthesizeFrontierReport,
  type FeedItem,
  type FrontierClassified,
  type FrontierReport,
} from "./news/frontier.js";
export {
  synthesizeMover,
  synthesizeBrief,
  classifyCategory,
  NEWS_CATEGORIES,
  type NewsCategory,
  type MoverInput,
  type MoverStory,
  type BriefInput,
  type MarketBrief,
  type ThemeStat,
  type CategoryOnly,
} from "./news/synthesize.js";
export { acquireSingletonLock } from "./singleInstance.js";
