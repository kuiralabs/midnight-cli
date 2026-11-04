// @kuiralabs/midnight-dev: what mn's development commands leave for a program
// and the packages above. The errors a caller classifies them by (localnet
// refused on this build, a test run's failed prep step), and where a state
// root keeps the localnet's compose file. Each name is listed, so the API is
// what this file says. The dev, test and localnet commands, dev's codes and
// guidance are "./commands".

export { getComposePath, LocalnetUnavailableError } from './lib/localnet.ts';
export { PrepStepFailedError } from './lib/test/prep-runner.ts';
