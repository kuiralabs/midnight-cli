// The `manual` command, described once (plan 2B, spec §4.1).

import type { CommandDefinition } from '../lib/command-definition.ts';

export const manualDefinition: CommandDefinition = {
  name: 'manual',
  order: 210,
  flags: [
    {
      name: 'no-pager',
      takesValue: false,
      help: ['--no-pager   Print straight to stdout, do not pipe through less'],
    },
    {
      name: 'raw',
      takesValue: false,
      help: ['--raw        Strip ANSI colors (useful for piping to a file)'],
    },
  ],
  help: {
    description: 'Full reference manual (long form, paged through $PAGER)',
    usage: 'midnight manual [--no-pager] [--raw] [--json]',
    flags: [
      { flag: 'no-pager' },
      { flag: 'raw' },
      '--json       Emit the manual text wrapped in a JSON object',
    ],
    examples: [
      'midnight manual',
      'midnight manual --no-pager | grep -i dust',
      'midnight manual --raw > MANUAL.txt',
    ],
    jsonFields: {
      name: 'CLI package name',
      version: 'CLI version',
      manual: 'Manual text (with ANSI colors)',
    },
  },
  intro: { brief: 'Full reference manual', order: 19 },
  needsWalletSdk: false,
  shell: {},
  load: () => import('./manual.ts'),
};
