// ANSI 256-color palette for Midnight CLI
// Colour only at a terminal: on when stdout and stderr are both TTYs, so no
// escape code reaches a pipe or a file. NO_COLOR (https://no-color.org/)
// turns it off; FORCE_COLOR (other than 0 or false) turns it on anyway.

const ESC = '\x1b[';
const RESET = '\x1b[0m';

// ANSI 256 color codes from DESIGN.md
export const MIDNIGHT_BLUE = 17;
export const TEAL = 38;
export const PURPLE = 99;
export const WHITE_CODE = 15;
export const DIM_GRAY = 245;
export const RED_CODE = 196;
export const GREEN_CODE = 40;
export const YELLOW_CODE = 226;

export function isColorEnabled(): boolean {
  if ('NO_COLOR' in process.env) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force !== 'false';
  return process.stdout.isTTY === true && process.stderr.isTTY === true;
}

// Low-level ANSI helpers

export function fg(text: string, code: number): string {
  if (!isColorEnabled()) return text;
  return `${ESC}38;5;${code}m${text}${RESET}`;
}

export function bg(text: string, code: number): string {
  if (!isColorEnabled()) return text;
  return `${ESC}48;5;${code}m${text}${RESET}`;
}

export function bold(text: string): string {
  if (!isColorEnabled()) return text;
  return `${ESC}1m${text}${RESET}`;
}

export function dim(text: string): string {
  if (!isColorEnabled()) return text;
  return `${ESC}2m${text}${RESET}`;
}

// Named color shortcuts

export function teal(text: string): string {
  return fg(text, TEAL);
}

export function purple(text: string): string {
  return fg(text, PURPLE);
}

export function red(text: string): string {
  return fg(text, RED_CODE);
}

export function green(text: string): string {
  return fg(text, GREEN_CODE);
}

export function yellow(text: string): string {
  return fg(text, YELLOW_CODE);
}

export function midnightBlue(text: string): string {
  return fg(text, MIDNIGHT_BLUE);
}

export function white(text: string): string {
  return fg(text, WHITE_CODE);
}

export function gray(text: string): string {
  return fg(text, DIM_GRAY);
}
