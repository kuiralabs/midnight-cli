// @kuiralabs/midnight-grant: what mn grant leaves for the shell, a program and
// the MCP server. The protector `wallet protect` runs to seal the accounts an
// earlier mn kept in plain text; the errors a caller classifies grant's
// refusals by (a network the account package can't act on, a Node.js too old
// for it, a wallet with no account, a caller pin the network's account can't
// hold); and where a state root keeps the
// accounts' records and the account package's proving artefacts. None of them
// loads the account package or its SDK set: the shell loads this entry point
// for every wallet command. Each name is listed, so the API is what this file
// says. The grant command, its codes and guidance are "./commands".

export { accountProtector } from './lib/grant/account-protector.ts';
export { NoAccountError, NodeTooOldForAccountError, UnreachableByAccountError } from './lib/grant/account-errors.ts';
export { accountArtifactsDir, accountRecordsDir } from './lib/grant/account-records.ts';
