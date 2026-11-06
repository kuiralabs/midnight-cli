// @kuiralabs/midnight-cli-core/ui: terminal output for commands: formatting,
// colours, the spinner and progress reporter, and the terminal prompter.

export { bold, dim, gray, green, isColorEnabled, purple, red, teal, white, yellow } from './ui/colors.ts';
export {
  divider, errorMessage, formatAddress, formatDust, formatNight, header, keyValue, roughDust,
  successMessage, toDust, toNight, usageMessage
} from './ui/format.ts';
export { silentSpinner, type Spinner, type SpinnerReporter, spinnerReporter, trackElapsed } from './ui/spinner.ts';
export { createTerminalPrompter } from './ui/terminal-prompter.ts';
