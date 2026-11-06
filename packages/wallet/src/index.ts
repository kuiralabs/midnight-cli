// @kuiralabs/midnight-wallet: mn's wallets for a program and the packages
// above. Reading balances, sending and airdropping NIGHT, Dust status,
// registration and export, and swap offers, each called with plain values;
// the session-level offer steps over a wallet session; seeds, sealed wallet
// files and mn's one passphrase. Each name is listed, so the API is what this
// file says. The wallet's commands, codes and guidance, and the terminal
// helpers the commands above use, are "./commands".

export { clearChainCaches } from './lib/chain-caches.ts';
export {
  checkPassphrase, establishPassphrase, isPassphraseSet, NoPassphraseError, type PassphraseHost,
  passphraseForNewSecret, type PassphraseSource, readPassphrase, unlockPassphrase
} from './lib/passphrase.ts';
export { type ResolvedSeed, type SeedHost, seedOf, type WalletSource } from './lib/seed-resolver.ts';
export {
  type CancelSwapOfferOptions, cancelSwapOffer, type CancelledSwapOffer
} from './lib/swap/cancel.ts';
export {
  type InspectSwapOfferOptions, inspectSwapOffer, type SwapOfferStanding
} from './lib/swap/inspect.ts';
export { type ListSwapOffersOptions, listSwapOffers, type SwapOffersListed } from './lib/swap/list.ts';
export {
  type CoinSplit, type MadeSwapOffer, makeSwapOffer, type MakeSwapOfferOptions, type SwapNetworkChosen
} from './lib/swap/make.ts';
export {
  cancelOffer, type CancelOutcome, type MadeOffer, makeOffer, NoSuchOfferError, type ReadOffer,
  readOfferFile, takeOffer
} from './lib/swap/offers.ts';
export {
  type SwapOfferChecked, takeSwapOffer, type TakeSwapOfferOptions, type TakenSwapOffer
} from './lib/swap/take.ts';
export {
  type AirdropAddressed, airdropNight, type AirdropNightOptions, type AirdropRecipient, type NightAirdrop
} from './lib/wallet/airdrop.ts';
export {
  type AddressBalance, readAddressBalance, type ReadAddressBalanceOptions, readWalletBalance,
  type ReadWalletBalanceOptions, type ShieldedHoldings, type UnshieldedRead, type WalletBalance
} from './lib/wallet/balance.ts';
export {
  type DustRegistered, type DustRegistrationCounts, type DustRegistrationResult, type DustStatus,
  type DustUnregistered, exportDustSnapshot, readDustStatus, type ReadDustStatusOptions, registerDust,
  type RegisterDustOptions
} from './lib/wallet/dust.ts';
export { type PaidCallOptions, type StepFailed, stepSpinner } from './lib/wallet/paid-call.ts';
export { type NightTransfer, transferNight, type TransferNightOptions } from './lib/wallet/transfer.ts';
export { networkChoiceOf, type WalletCallOptions, type WalletOpened } from './lib/wallet/wallet-call.ts';
export { assertWalletCanPay } from './lib/wallet-can-pay.ts';
export {
  assertWalletFileExists, assertWalletRemovable, getActiveWalletName, listWallets, loadWalletConfig,
  type ProtectedWallet, protectAllWallets, resolveWalletPath, setActiveWallet, type UnlockedWallet,
  type UnlockHost, type UnlockOptions, unlockWallet, walletAddress, type WalletConfig, type WalletInfo,
  WalletNotFoundError, type WalletSecrets
} from './lib/wallet-config.ts';
export { createWallet, type CreatedWallet, walletFilePath, type WalletSecret, walletSecretFrom } from './lib/wallet-create.ts';
export { migrateOldWallet } from './lib/wallet-paths.ts';
export { type ProtectedItem, type ProtectorResult, type WalletProtector } from './lib/wallet-protector.ts';
