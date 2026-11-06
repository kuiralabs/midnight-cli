// How a library asks the person a question: through the prompter its caller
// gives (the host's: host.prompter; the CLI's asks at the terminal,
// ui/terminal-prompter.ts). A library never opens a prompt itself; with no
// prompter, or one that can't ask, it does what it did with no terminal.

export interface Prompter {
  /** Whether there is someone to answer. */
  isInteractive(): boolean;
  /** Asks `question`; the answer, or null when the input ends first. Refuses (PromptBusyError) while another question is open. */
  ask(question: string): Promise<string | null>;
  /** Asks `question` with nothing echoed; the answer, or null when the input ends first. Refuses (PromptBusyError) while another question is open. */
  askSecret(question: string): Promise<string | null>;
}

/** Thrown when a question is asked while another is open: one person at one terminal answers one at a time. */
export class PromptBusyError extends Error {
  constructor() {
    super('Another question is waiting for an answer at the terminal; answer it first.');
    this.name = 'PromptBusyError';
    Object.setPrototypeOf(this, PromptBusyError.prototype);
  }
}
