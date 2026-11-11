// What mn says when the wallet that is to pay can't: it named a deploy for
// every command ("Fund your wallet before deploying"), and told a wallet that
// held only shielded NIGHT it had 0 NIGHT and to airdrop, without saying why
// its NIGHT couldn't pay. The refusal names what was to be paid for, counts
// shielded NIGHT, says that only registered unshielded NIGHT generates the
// Dust fees are paid in, and gives each network's own steps.

import { describe, expect, it } from 'vitest';
import { DustRequiredError, InsufficientBalanceError, nightToMicro } from '@kuiralabs/midnight-cli-core';
import { noDustError, noNightError } from '../lib/wallet-can-pay.ts';

const ADDRESS = 'mn_addr_undeployed1mqt82ae7yg4qx4yy52x6tew47rzrvujxmg0vzy2hne74utcurzyqmlvtvq';

describe('noNightError', () => {
  it('names the command that was refused, not a deploy', () => {
    const err = noNightError({ network: 'undeployed', paying: 'calling withdraw on escrow', address: ADDRESS, wallet: undefined, unshieldedNight: 0n, shieldedNight: 0n });
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect(err.message).toMatch(/^Can't pay for calling withdraw on escrow on undeployed: the wallet has no unshielded NIGHT\.\n/);
    expect(err.message).not.toContain('deploying');
  });

  it('says why a wallet holding only shielded NIGHT cannot pay, and what to do on the local network', () => {
    const err = noNightError({ network: 'undeployed', paying: 'deploying escrow', address: ADDRESS, wallet: 'shy', unshieldedNight: 0n, shieldedNight: nightToMicro(5) });
    expect(err.message).toBe(
      "Can't pay for deploying escrow on undeployed: the wallet has no unshielded NIGHT. It holds 5 shielded NIGHT, which can't pay a fee.\n"
      + 'Fees are paid in Dust, and Dust comes only from unshielded NIGHT registered for Dust generation; shielded NIGHT generates none.\n\n'
      + `  1. Get unshielded NIGHT to ${ADDRESS}:\n`
      + '     midnight airdrop --wallet shy   (50000 NIGHT from the local genesis wallet)\n'
      + `     or another wallet sends it: midnight transfer ${ADDRESS} <amount>\n`
      + "     (mn can't move this wallet's own shielded NIGHT to its unshielded address.)\n"
      + '  2. Register it for Dust generation:\n'
      + '     midnight dust register --wallet shy --network undeployed\n',
    );
  });

  it('offers no airdrop on preview, preprod or mainnet', () => {
    const preprod = noNightError({ network: 'preprod', paying: 'deploying escrow', address: ADDRESS, wallet: undefined, unshieldedNight: 0n }).message;
    expect(preprod).not.toContain('airdrop');
    expect(preprod).toContain('the Midnight faucet for preprod, or another wallet sends it');
    expect(preprod).toContain('midnight dust register --network preprod');
    // Shielded NIGHT isn't read there: nothing is said about how much.
    expect(preprod).not.toContain('It holds');

    const preview = noNightError({ network: 'preview', address: ADDRESS, wallet: undefined, unshieldedNight: 0n }).message;
    expect(preview).toMatch(/^Can't pay for this transaction on preview:/);
    expect(preview).not.toContain('airdrop');

    const mainnet = noNightError({ network: 'mainnet', paying: 'grant deploy', address: ADDRESS, wallet: undefined, unshieldedNight: 0n }).message;
    expect(mainnet).not.toContain('airdrop');
    expect(mainnet).not.toContain('faucet');
    expect(mainnet).toContain(`another wallet sends it: midnight transfer ${ADDRESS} <amount>`);
  });
});

describe('noDustError', () => {
  it('names the command and tells the wallet to register its unshielded NIGHT', () => {
    const err = noDustError({ network: 'undeployed', paying: 'grant deposit', address: ADDRESS, wallet: 'alice', unshieldedNight: nightToMicro(1000) });
    expect(err).toBeInstanceOf(DustRequiredError);
    expect(err.message).toMatch(/^Can't pay for grant deposit on undeployed: the wallet has 1000 unshielded NIGHT and no Dust\./);
    expect(err.message).toContain('midnight dust register --wallet alice --network undeployed');
    expect(err.message).toContain('midnight dust status --wallet alice --network undeployed');
  });
});
