// The offer reader on the rc engine. The tests are the suite both engines run: helpers/offer-reader-suite.ts.

import * as ledger from '@midnightntwrk/ledger-v9';
import { readOffer, spentNullifiers } from '../offer-reader.ts';
import { offerReaderSuite } from '../../../../test-support/offer-reader-suite.ts';

offerReaderSuite({ set: 'rc', ledger, readOffer, spentNullifiers });
