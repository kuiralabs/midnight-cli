// The fixture command's handler: it refuses every call, through refuses.ts.

import { refuse } from './refuses.ts';

export default async function fixtureCommand(): Promise<void> {
  refuse('the fixture takes no offer');
}
