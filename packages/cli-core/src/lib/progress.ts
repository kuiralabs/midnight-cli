// What a library function says while it works, for whoever runs it: each step
// starts, may say more as it goes, and ends, in words for a person. The CLI
// shows them on its spinners (ui/spinner.ts spinnerReporter), the MCP server
// sends them as progress notifications, and a program does as it likes. A
// function may add events of its own that carry values (a balance read so
// far), typed beside it.

/** One step of a library function's work, in words for a person. */
export type ProgressEvent =
  | { readonly kind: 'start'; readonly message: string }
  | { readonly kind: 'update'; readonly message: string }
  | { readonly kind: 'done'; readonly message: string };

/** Where a library function's progress events go. */
export type ProgressListener<Event = ProgressEvent> = (event: Event) => void;

/** How a library function says its steps: to `listener`, or nowhere when none is given. */
export interface ProgressSteps {
  start(message: string): void;
  update(message: string): void;
  done(message: string): void;
}

/** The steps a function says, to `listener` when there is one. */
export function progressSteps(listener: ProgressListener | undefined): ProgressSteps {
  return {
    start: (message) => listener?.({ kind: 'start', message }),
    update: (message) => listener?.({ kind: 'update', message }),
    done: (message) => listener?.({ kind: 'done', message }),
  };
}
