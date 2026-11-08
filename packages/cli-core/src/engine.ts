// @kuiralabs/midnight-cli-core/engine: what an SDK engine is built against.
// The engine contract (the Engine interface and its parts), reading the SDK's
// and the node's errors (sdk-errors), the wallet cache, the Dust balancing and
// registration plans, the SDK layout check, transaction hex, and the constants
// and helpers the engines use that no other package does.

export { type ApprovalOptions, promptApproval } from './lib/approval.ts';
export { bindCachesToIndexer, describeIndexerChange } from './lib/cache-indexer.ts';
export {
  ABANDONED_TX_TIMEOUT_MS, DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN,
  DUST_REGISTRATION_RETRY_DELAY_MS, DUST_REGISTRATION_TIMEOUT_MS, DUST_RETRY_ATTEMPTS,
  DUST_RETRY_DELAY_MS, DUST_TIMEOUT_MS, INITIAL_DUST_GRACE_PERIOD_SECONDS,
  INITIAL_GENERATION_DECAY_RATE, INITIAL_NIGHT_DUST_RATIO, MAX_RETRY_ATTEMPTS, MIN_DUST_FOR_TRANSFER,
  PRE_SEND_SYNC_TIMEOUT_MS, PROOF_TIMEOUT_MS, STALE_UTXO_ERROR_CODE, SYNC_ATTEMPT_TIMEOUT_MS,
  SYNC_TIMEOUT_MS, TOKEN_MULTIPLIER, TX_TTL_MINUTES
} from './lib/constants.ts';
export { type CoinPicking, type CoinRule, createCoinPicking, type PickableCoin, pickCoin } from './lib/coin-picker.ts';
export { chooseDustCoins, type DustInput, planDustInputs, spreadFeeAcrossInputs } from './lib/dust-balancing-plan.ts';
export { DustFeeNotGeneratedError, planRegistration, type RegistrationContext } from './lib/dust-registration-plan.ts';
export { type DustCoinGeneration, dustGenerationCap } from './lib/dust-cap.ts';
export { awaitDustForFee, DUST_SHORT_WAIT_MS, type DustWaitPlan, payWhenDustCovers, planDustWait, sleep } from './lib/dust-wait.ts';
export {
  type AccountEntryPoint, type AirdropParams, type BlockLimits, type CachedReadOptions, type CallScript, type DAppConnector,
  type DAppConnectorCallbacks, type DeployScript, type DustBalance, type DustExportResult,
  type DustRegisterOptions, type DustRegistration, type Engine, type EngineAccountPackage, type EngineHost, type EngineWallet,
  type EnsureDustResult, type OpenedConnector, type PrepWallet, type RawStateValue, type ReadOptions,
  type ScriptParts, type ServedWalletSession, type ShieldedBalanceResult, type ShieldedCachedOptions,
  type ShieldedTransferParams, type StateScript, type TransactionDetail, type TransferParams,
  type TransferRecipient, type TransferResult, type UnshieldedView
} from './lib/engine.ts';
export { EngineError, ProofTimeoutError } from './lib/errors.ts';
export { proveWithin, SUBMIT_WAIT_MS, submitWithin, type SubmitWaitOptions } from './lib/submit-wait.ts';
export { DEFAULT_FEE_LIMITS, feeLimitRefusal, type FeeLimits, pendingLimitRefusal } from './lib/fee-limits.ts';
export {
  DUST_FEE_MARGIN_STEPS, type FeePricing, type FeeRefusalCheck, type FeeRefusalStep, isFeeShortRefusal, newFeePricing, nextFeeMargin,
  repriceAfterFeeRefusal, repricingStatus, resetFeeMargin
} from './lib/fee-margin.ts';
export { getNetworkId, networkIdForName } from './lib/network-id.ts';
export { assertSpendsNoOfferCoin } from './lib/open-offers.ts';
export { createPhaseTracker, type PhaseTracker } from './lib/phase-tracker.ts';
export { dustCacheDir, getDustCachePath, getShieldedCachePath, nativeCheckpointName } from './lib/reader-cache-files.ts';
export {
  type DustShortfall, dustShortfallOf, heldCoinRefusalOf, isColdStartRace, isDustRelatedError, isDustShortage,
  isSdkInsufficientFundsError, markingEngineCodes, refusalCodeOf, reportingEngineErrors, toEngineError,
  withDustShortfall, withEngineCode
} from './lib/sdk-errors.ts';
export { assertInstalledAsShipped, assertOneSdkCopy, MixedSdkLayoutError, NotInstalledAsShippedError, resolvedPackageFolder, shippedTreeDrift, type TreeDrift } from './lib/sdk-layout.ts';
export { decodeSignPayload, signedMessageBytes } from './lib/sign-data.ts';
export { describeLeg, NotAnOfferError } from './lib/swap-offer.ts';
export { fromHex, toHex } from './lib/tx-serde.ts';
export {
  cacheRootDir, clearWalletCache, getCachePath, loadWalletCache, networkCacheFolder, saveWalletCache, walletCacheFileName,
  validateWalletCacheChainId, type WalletCacheData
} from './lib/wallet-cache.ts';
