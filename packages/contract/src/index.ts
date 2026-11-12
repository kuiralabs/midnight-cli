// @kuiralabs/midnight-contract: mn's contracts for a program and the packages
// above. Deploying a contract, calling a circuit and reading a contract's
// state, each called with plain values and paid through a payer, and what a
// deploy or call costs before it is proven (alone, with nothing sent); the requests
// they are built from (a dApp folder, the contract in it, its arguments); a
// compiled contract's circuits and witnesses; and the runner the packages
// above run a deploy, a call or a state read with in a dApp's folder, with
// the dApp's private state they share. Each name is listed, so the API is what
// this file says. The contract and inspect-cost commands, contract's codes and
// guidance are "./commands". A request's arguments never reach a script's
// text: a fresh-coin shorthand is expanded in the request, and the runner
// hands the script its arguments through an owner-only file it deletes.

export { type ArgsSource } from './lib/contract/args-input.ts';
export { type CallContractOptions, type CalledCircuit, callContract, priceContractCall } from './lib/contract/call.ts';
export { COIN_SHORTHAND_KEY, type FreshCoin } from './lib/contract/coin-shorthand.ts';
export { type ContractCost, contractCostJson, contractCostOf, type ContractPriced, type PricedContract } from './lib/contract/cost.ts';
export { type DeployContractOptions, type DeployedContract, deployContract, priceContractDeploy } from './lib/contract/deploy.ts';
export { ContractAssertionError } from './lib/contract/assertion.ts';
export { contractExists } from './lib/contract/exists.ts';
export { HELD_COINS_KEY, type HeldCoin } from './lib/contract/held-coins.ts';
export { type CircuitInfo, type CompactType, type ContractInfo, ContractInfoInvalidError, ContractNotCompiledError, findContractInfo, type WitnessInfo } from './lib/contract/inspect.ts';
export { clearDappPrivateState, clearNetworkContractState, contractStateDir, PRIVATE_STATE_DATABASE } from './lib/contract/private-state.ts';
export {
  type ContractCallRequest, contractCallRequest, type ContractDeployRequest, contractDeployRequest, type ContractLocation
} from './lib/contract/request.ts';
export {
  type CallOptions, type CallResult, ContractScriptError, type DeployOptions, type DeployResult, NotPricedError, priceCall, priceDeploy, runCall, runDeploy,
  type RunnerOptions, runState, type StateOptions, type StateResult
} from './lib/contract/runner.ts';
export { type ContractChecked } from './lib/contract/runtime-check.ts';
export {
  ContractNotFoundError, type ContractState, type ParsedContractState, type RawContractState, readContractState, type ReadContractStateOptions,
  type StateFallback, type StateReading
} from './lib/contract/state.ts';
export { buildMissingWitnessError, findWitnessFile, WitnessesNotFoundError } from './lib/contract/witness-discovery.ts';
export { ContractArgumentError } from './lib/contract/argument-error.ts';
