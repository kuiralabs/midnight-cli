// A test file for the layering check that reaches into core's source by path
// instead of by an entry point: the check refuses it.

import { UsageError } from '../../../../packages/cli-core/src/lib/errors.ts';

export const refused = UsageError;
