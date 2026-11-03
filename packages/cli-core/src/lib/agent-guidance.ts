// Agent guidance per package: each package brings
// its pieces of the three texts that teach agents to use mn, the way it brings
// its commands. `help --agent` is the shell's; the two skills the MCP server
// serves (skill/core, and skill/full with its legacy alias) are the server's.
// Each text is a skeleton of sections its assembler owns; a piece names its
// text, its section and its place there, so a section several packages share
// reads in the order their places give. An error code's row sits with the
// package whose code raises it; text about no one package's commands
// (concepts, networks, safety, JSON, the MCP server) stays with the assembler.
// A package's error-code rows are made from its code definitions
// (codeGuidancePieces), never written by hand.

import type { CodeDefinition } from './error-codes.ts';

/** The texts agents read: the `help --agent` manual, and the core and full skills. */
export type GuidanceText = 'agent-manual' | 'skill-core' | 'skill-full';

/** A piece of one text, exactly as it reads there, newlines included. */
export interface GuidancePiece {
  readonly text: GuidanceText;
  /** The section of that text it belongs to. */
  readonly section: string;
  /** Its place in the section: pieces read in ascending order. */
  readonly order: number;
  readonly body: string;
}

/**
 * A tool's row in the manual's table of MCP tools, which the shell generates
 * from the registry's tools: the topic group it sits in, its place there, and
 * what it says.
 */
export interface ToolsTableRow {
  readonly tool: string;
  readonly group: string;
  readonly order: number;
  /** The description, line by line. */
  readonly description: readonly string[];
  /** The parameters column, line by line; absent: the tool's required parameters, or — when none. */
  readonly params?: readonly string[];
}

/** A section a package adds to a text, for its own pieces: placed right after a section the text has. */
export interface GuidanceSection {
  readonly text: GuidanceText;
  readonly name: string;
  /** The section it follows: one of the text's own, or one another package adds. */
  readonly after: string;
}

/** What a package tells agents. */
export interface PackageGuidance {
  readonly pieces: readonly GuidancePiece[];
  /** Sections it adds to the texts, beyond the ones their assemblers own. */
  readonly sections?: readonly GuidanceSection[];
  readonly toolsTable?: readonly ToolsTableRow[];
}

/** Thrown when guidance has no place in its text, or two pieces claim the same place. */
export class GuidanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuidanceError';
  }
}

/** The pieces, among these, of a text that name a section its skeleton lacks. */
export function unplacedPieces(text: GuidanceText, sections: readonly string[], pieces: readonly GuidancePiece[]): GuidancePiece[] {
  return pieces.filter((piece) => piece.text === text && !sections.includes(piece.section));
}

/**
 * A text's sections: its skeleton's, each followed by the sections packages
 * add after it (several after one in the order given, each followed by its
 * own). Refuses a section added twice or over one the text has, and one
 * placed after a section the text doesn't have.
 */
export function sectionsWithAdded(text: GuidanceText, skeleton: readonly string[], added: readonly GuidanceSection[]): string[] {
  const own = added.filter((section) => section.text === text);
  const names = new Set<string>(skeleton);
  for (const { name } of own) {
    if (names.has(name)) throw new GuidanceError(`Section "${name}" of ${text} is added twice, or over one it has`);
    names.add(name);
  }
  const sections: string[] = [];
  const place = (name: string): void => {
    sections.push(name);
    for (const next of own.filter((section) => section.after === name)) place(next.name);
  };
  skeleton.forEach(place);
  const unplaced = own.filter((section) => !sections.includes(section.name));
  if (unplaced.length > 0) {
    throw new GuidanceError(`No section of ${text} is called ${unplaced.map((section) => `"${section.after}"`).join(', ')}, which ${unplaced.map((section) => `"${section.name}"`).join(', ')} should follow`);
  }
  return sections;
}

/** Refuses two pieces in one place of one section. */
export function assertDistinctPlaces(pieces: readonly GuidancePiece[]): void {
  const seen = new Set<string>();
  for (const { text, section, order } of pieces) {
    const place = `${text} ${section} ${order}`;
    if (seen.has(place)) throw new GuidanceError(`Two pieces of ${text} take place ${order} in section "${section}"`);
    seen.add(place);
  }
}

/**
 * A text from its skeleton (its sections, in order) and the pieces of every
 * party, the assembler's own included: each section's pieces in their order.
 */
export function assembleGuidance(text: GuidanceText, sections: readonly string[], pieces: readonly GuidancePiece[]): string {
  const unplaced = unplacedPieces(text, sections, pieces);
  if (unplaced.length > 0) {
    throw new GuidanceError(`No section of ${text} is called ${unplaced.map((piece) => `"${piece.section}"`).join(', ')}`);
  }
  const own = pieces.filter((piece) => piece.text === text);
  assertDistinctPlaces(own);
  return sections
    .flatMap((section) => own.filter((piece) => piece.section === section).sort((a, b) => a.order - b.order))
    .map((piece) => piece.body)
    .join('');
}

// The manual's table of codes: the code in a column of 24, its exit code, and
// the meaning from column 32, wrapped at 48 characters; a code too long for
// its column puts its exit code beside it and the meaning on the next line.
const CODE_COLUMN = 24;
const MEANING_COLUMN = 32;
const MEANING_WIDTH = 48;

/** `text` in lines of at most `width` characters, broken between words (a word longer than that keeps a line of its own). */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** A code's row in the `help --agent` manual's table: code, exit code, and its summary as the meaning. */
export function manualCodeRow(definition: CodeDefinition): string {
  const [first = '', ...rest] = wrapWords(definition.summary, MEANING_WIDTH);
  const indent = ' '.repeat(MEANING_COLUMN);
  const head = definition.code.length < CODE_COLUMN
    ? `  ${definition.code.padEnd(CODE_COLUMN)}${definition.exitCode}`
    : `  ${definition.code} ${definition.exitCode}`;
  const lines = head.length < MEANING_COLUMN
    ? [`${head.padEnd(MEANING_COLUMN)}${first}`, ...rest.map((line) => indent + line)]
    : [head, ...[first, ...rest].map((line) => indent + line)];
  return lines.join('\n') + '\n';
}

/** A code's row in the full skill's table of error recovery recipes: code, summary, recovery. */
export function skillCodeRow(definition: CodeDefinition): string {
  // A pipe splits a table cell, inside a code span too, unless escaped.
  const cell = (text: string): string => text.replaceAll('|', '\\|');
  return `| \`${definition.code}\` | ${cell(definition.summary)} | ${cell(definition.recovery ?? '')} |\n`;
}

/**
 * A package's error-code rows, from its code definitions: each code's row in
 * the manual's 'error-codes' section and in the full skill's 'error-recovery'
 * table, placed by its `order`. Refuses a code with no order (its rows would
 * have no place) or no recovery (its recipe would be empty).
 */
export function codeGuidancePieces(codes: readonly CodeDefinition[]): GuidancePiece[] {
  return codes.flatMap((definition) => {
    if (definition.order === undefined) throw new GuidanceError(`Error code "${definition.code}" has no order, so its rows have no place`);
    if (definition.recovery === undefined) throw new GuidanceError(`Error code "${definition.code}" has no recovery for its recipe`);
    return [
      { text: 'agent-manual', section: 'error-codes', order: definition.order, body: manualCodeRow(definition) },
      { text: 'skill-full', section: 'error-recovery', order: definition.order, body: skillCodeRow(definition) },
    ] satisfies GuidancePiece[];
  });
}
