// @kuiralabs/midnight-cli-core: the library a program and the packages above
// call. Typed errors and their codes, the host, networks and network targets,
// the payer, progress, amounts, arguments, settings and the state root, the
// wallet session and swap offer types, and the rest the packages above core
// import. Each name is listed, so the API is what this file says.
// Engine implementors also import "./engine"; terminal output is "./ui";
// core's command, codes and guidance are "./commands"; what a host does to its
// own process (the SDK rejection guard, the sync heap) is "./process".

export {
  assembleGuidance, codeGuidancePieces, GuidanceError, type GuidancePiece, type GuidanceText,
  listedNames, manualCodeRow, type PackageGuidance, sectionsWithAdded, skillCodeRow, type ToolsTableRow, wrapWords
} from './lib/agent-guidance.ts';
export { nightAmountJson, nightAmountText, nightToMicro, parseAmount } from './lib/amount.ts';
export { type ApprovalPolicy, describeApprovalPolicy } from './lib/approval.ts';
export {
  FULL_FLAG, getFlag, getFlagValues, hasFlag, isMinimalMode, MINIMAL_FLAG, parseArgs, type ParsedArgs,
  rejectNoCacheForWrites, requireFlag
} from './lib/argv.ts';
export {
  assertEndpointUsable, blockfrostEndpoints, BlockfrostLimitError, BlockfrostProjectIdRejectedError,
  BlockfrostProjectIdRequiredError, endpointRefusal, endpointRefusalFromWsError, EndpointShutDownError,
  isBlockfrostUrl, isEndpointError, mayHoldProjectId, redactProjectId
} from './lib/blockfrost.ts';
export {
  type CallContext, callDiagnostics, type CallOutput, type CallProgress, type CommandHandler,
  type CommandOutcome, createCallContext, runHandler, SecondResultError
} from './lib/call-context.ts';
export {
  type CliConfig, CorruptConfigError, getConfigValue, getEndpointOverridesForNetwork, loadCliConfig, saveCliConfig,
  setConfigValue
} from './lib/cli-config.ts';
export {
  type CommandDefinition, CommandDefinitionError, commandErrorCodes, commandExitCodes,
  type CommandHelpSpec, commandHelpSpecs, commandOwnCodes, type CommandPackage, type CommandRegistry,
  confirmationTarget, confirmationText, createCommandRegistry, createPackageRegistry, declaredCodes,
  declaredCodeSets, declaredSets, ENDPOINT_PARAMS, type FlagDefinition, type GlobalFlagHelp,
  introBriefs, needsConfirmation, NETWORK_PARAM, type RegisteredTool, type ToolAnnotations, toolArgv,
  type ToolCheckCall, type ToolDefinition, type ToolInputSchema
} from './lib/command-definition.ts';
export { assertKnownFlags, findMisplacedFlags, findUnknownFlags } from './lib/command-flags.ts';
export {
  type APIError, createApiError, type ErrorCode, OPERATOR_REJECTED_MESSAGE, APPROVAL_UNAVAILABLE_MESSAGE, type RpcHandler,
  type RpcHandlerContext
} from './lib/connector-api.ts';
export {
  BALANCE_CHECK_TIMEOUT_MS, DASHBOARD_BASE_URL, DEFAULT_CONFIG_FILENAME, DEFAULT_SERVE_PORT, DEFAULT_WALLET_FILENAME,
  DEFAULT_WALLET_NAME, DIR_MODE, FILE_MODE, GENESIS_SEED, isValidWalletName, LOCAL_WALLET_FUNDING_NIGHT, LOCALNET_DIR_NAME,
  MAX_WALLET_NAME_LENGTH, MIDNIGHT_DIR, MN_RPC_METHOD_PREFIX, NATIVE_TOKEN_TYPE, PRICE_TRANSACTION_METHOD, PROOF_SERVER_DOCKER_RUN, PROOF_SERVER_IMAGE, SYNC_HEAP_MIN_GAIN_MB, SYNC_HEAP_RAM_FRACTION, SYNC_HEAP_TARGET_MB,
  WALLETS_DIR_NAME
} from './lib/constants.ts';
export { FileExistsError, readJsonIfPresent, writeJsonDurably } from './lib/durable-file.ts';
export { assertValidWalletName, InvalidWalletNameError } from './lib/wallet-name.ts';
export { ensureOwnerOnlyDir, narrowToOwnerOnly } from './lib/owner-only.ts';
export { formatWait } from './lib/duration.ts';
export { dustShortError, OWN_COMMAND_DUST_WAIT_MS } from './lib/dust-wait.ts';
export { type TransactionPrice, type TransactionPriceWire, transactionPriceFromWire } from './lib/transaction-price.ts';
export {
  type BalanceSummary, type DAppConnector, type DAppConnectorCallbacks, type DustExportResult,
  type Engine, type EngineContractScripts, type EngineKeys, type HostEngines, type OpenedConnector,
  type RawStateValue, type ScriptParts, type SdkSet, sdkSetOf
} from './lib/engine.ts';
export {
  type CodeDefinition, CodeDefinitionError, type CodeRegistry, type CodeSet, defineCodes,
  defineCodeSet
} from './lib/error-codes.ts';
export { trimAgentMessage } from './lib/error-trim.ts';
export { stateDecodeFailureOf } from './lib/contract-state-errors.ts';
export { DUST_LOCK_WAIT_MS, type DustLockSay, walletDustLock, walletDustLockFile, type WalletDustLock } from './lib/wallet-dust-lock.ts';
export { acquireProcessLock, holderCommandOf, type LockHolder, processIsAlive, type ProcessLockDeps, type ProcessLockOptions, type TakenLock } from './lib/process-lock.ts';
export {
  ACCOUNT_ARTIFACTS_KEY, type AccountArtifactsSource, checkAccountArtifactsSource, InvalidAccountArtifactsSourceError, resolveAccountArtifactsSource
} from './lib/account-artifacts.ts';
export {
  asReported, CANCELLED_MESSAGE, CancelledError, CommandFailedError, ContractStateUnreadableError, DustDoubleSpentError, DustRequiredError,
  FeeRepricedError, FeeTooLowError, InsufficientBalanceError, isUsageError, NetworkError, ProofFailureError, SyncTimeoutError,
  throwIfCancelled, TransactionInvalidatedError, TransactionRefusedError, UsageError, WalletBehindForkError, type WalletBehindFork, walletsBehindForkMessage, type WalletPart
} from './lib/errors.ts';
export { execProgram, type ExecRun, type ExecRunner, ProgramFailedError, ProgramTimedOutError } from './lib/exec-program.ts';
export {
  classifyError, ERROR_CODES, EXIT_CANCELLED, EXIT_GENERAL_ERROR, EXIT_INSUFFICIENT_BALANCE,
  EXIT_INVALID_ARGS, EXIT_NETWORK_ERROR, EXIT_TX_REJECTED, EXIT_WALLET_NOT_FOUND, humanizeNetworkError
} from './lib/exit-codes.ts';
export { type FeeLimits, parseFeeLimits } from './lib/fee-limits.ts';
export { DUST_DOUBLE_SPEND_RETRIES, DUST_DOUBLE_SPENT_CODE, DUST_FEE_MARGIN_STEPS, FEE_REPRICED_CODE, FEE_TOO_LOW_CODE, isDustDoubleSpent, isSpentFirst, isTxInvalidated, RERUN_DOUBLE_SPENT_STATUS, RERUN_INVALIDATED_STATUS, isFeeRepriced, RERUN_REPRICED_STATUS, rerunSpentFirstStatus, rerunWhenRepriced, TX_INVALIDATED_CODE } from './lib/fee-margin.ts';
export { createHost, defineHostSlot, type Host, type HostOptions } from './lib/host.ts';
export { writeJsonError, writeJsonResult } from './lib/json-output.ts';
export {
  freshDataKey, isSealedSecret, type KeyedSecret, openSecret, openWithKey, type SealedSecret,
  sealSecret, sealWithKey, WrongPassphraseError
} from './lib/keystore.ts';
export { MainnetRefusedError, refuseOnMainnet } from './lib/mainnet-refusal.ts';
export {
  addressPrefix, AmbiguousLocalStacksError, applyEndpointOverrides, assertValidNetworkName, detectLocalStacks, detectNetworkFromAddress,
  endpointFlags, type EndpointOverrides, getNetworkConfig, getValidNetworkNames, isNamedOnlyNetwork,
  InvalidNetworkError, isValidNetworkName, LEDGER_9_FORK_VERSION, looksLikeShieldedAddress, looksLikeUnshieldedAddress,
  type NetworkConfig, type NetworkName, NetworkNotNamedError, resolveNetworkConfig, RetiredNetworkError
} from './lib/network.ts';
export { type NetworkChoice, networkChoiceFromArgs, networkTargetOf } from './lib/network-target.ts';
export { type NoticeSink, type WaitSink } from './lib/notices.ts';
export {
  assertEnvelopeMatches, assertOfferUnexpired, decodeOfferEnvelope, encodeOfferEnvelope,
  type OfferEnvelope, OfferExpiredError
} from './lib/offer-envelope.ts';
export { closeOpenOffers, OfferCoinsInUseError, OfferRecordUnreadableError, type OfferSettlement, type OpenOffer, readOpenOffers, readSettledOffers, recordOpenOffer, SETTLED_OFFER_KEEP_DAYS, type SettledOffer, type Settlement } from './lib/open-offers.ts';
export {
  type ConnectOptions, NoPayerError, type Payer, payerFor, type PayingTarget, resolvePayingTarget,
  type ServedWallet
} from './lib/payer.ts';
export { type PhaseTiming } from './lib/phase-tracker.ts';
export { type ProgressEvent, type ProgressListener, type ProgressSteps, progressSteps } from './lib/progress.ts';
export { type Prompter } from './lib/prompter.ts';
export { clearDustDirectCache, clearNativeDustCheckpoint, clearShieldedDirectCache } from './lib/reader-cache-files.ts';
export { type NetworkSettings, resolveBlockfrostProjectId, resolveNetwork, resolveNetworkName } from './lib/resolve-network.ts';
export {
  captureCommand, type CommandRun, type Provided, runCommand, type RunnableDefinition, toolDescription
} from './lib/run-command.ts';
export {
  type CallSdkWarnings, createSdkWarningRouter, sdkTransientWarning, type SdkWarningCalls,
  withCallSdkWarnings
} from './lib/sdk-warnings.ts';
export { PASSPHRASE_ENV, DUST_SYNC_BIN_ENV, DISABLE_NATIVE_DUST_ENV, type Settings, settingsFromEnvironment } from './lib/settings.ts';
export { shieldedDisabledReason, shieldedSyncEnabled } from './lib/shielded-policy.ts';
export { type ContractKeys, contractKeysFromSeed } from './lib/contract-keys.ts';
export { sleep, untilCancelled } from './lib/sleep.ts';
export { NoStateRootError } from './lib/state-root.ts';
export { checkTerms, type OfferContents, type SwapLeg, type SwapTerms, TermsMismatchError } from './lib/swap-offer.ts';
export { carriesOwnCode, isTransientNetworkFailure, isTransportFailure, retryingTransient, TRANSIENT_RETRY_DELAYS_MS, type TransientRetryOptions, withTransportCode } from './lib/transport-failure.ts';
export { type EndpointRole, EndpointUnreachableError, endpointUnreachable, NotAProofServerError, ProofServerDroppedError, transportReason } from './lib/endpoint-unreachable.ts';
export { type VerboseLog } from './lib/verbose.ts';
export { clearWalletCache } from './lib/wallet-cache.ts';
export { openWalletSession, type OpenWalletSessionOptions, sessionOver, type SessionSubmitBounds, type WalletSession } from './lib/wallet-session.ts';
