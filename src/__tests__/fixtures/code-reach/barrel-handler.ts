// The barrel fixture command's handler: it refuses every call, through the barrel's refuse.

import { refuse } from './barrel.ts';

export default async function barrelFixtureCommand(): Promise<void> {
  refuse('the fixture takes no offer');
}
