// A test file for the layering check that imports a module of core that is
// not one of its entry points: the check refuses it, naming the entry points.

// @ts-expect-error core's exports map has no ./lib/errors, so TypeScript finds no module either
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';

export const refused = UsageError;
