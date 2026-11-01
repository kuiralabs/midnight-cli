// Agent guidance per package (spec §4.3, D19, plan 2G): each package brings
// its pieces of the three texts that teach agents to use mn, the way it brings
// its commands. `help --agent` is the shell's; the two skills the MCP server
// serves (skill/core, and skill/full with its legacy alias) are the server's.
// Each text is a skeleton of sections its assembler owns; a piece names its
// text, its section and its place there, so a section several packages share
// reads in the order their places give. An error code's row sits with the
// package whose code raises it; text about no one package's commands
// (concepts, networks, safety, JSON, the MCP server) stays with the assembler.

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

/** What a package tells agents. */
export interface PackageGuidance {
  readonly pieces: readonly GuidancePiece[];
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
