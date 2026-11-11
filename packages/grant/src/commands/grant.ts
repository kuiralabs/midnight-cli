import { deviceKeyOf, identityCodeOf, parseDeviceCode } from '../lib/grant/device-code.ts';
import { existsSync } from 'node:fs';
// grant command — the wallet owner's account, and the grants that let an agent spend from it
// Usage: midnight grant <deploy|deposit|status|list|issue|revoke|revoke-all> [options]
//
// The account's owner code is the account package mn installs
// (@kuiralabs/midnight-account-chain), called in this process through the
// engine of the network's SDK set, which installs its copy. status and list
// read the account without a wallet, and so does an issue shown but not
// confirmed. The others are paid by this wallet, through its DApp connector in
// this process: no server, no port.

import { type ParsedArgs, hasFlag, getFlag, DustRequiredError, UsageError, type CallContext, payerFor, throwIfCancelled, withTransportCode, NATIVE_TOKEN_TYPE, loadCliConfig, resolveAccountArtifactsSource } from '@kuiralabs/midnight-cli-core';
import { dim, header, keyValue, formatNight, type Spinner } from '@kuiralabs/midnight-cli-core/ui';
import { accountChainFor } from '../lib/grant/account-chain.ts';
import { type GrantAccount, openGrantAccount, ownerDeviceOf } from '../lib/grant/account.ts';
import { accountKeysFailureOf } from '../lib/grant/account-keys.ts';
import { deployShortOfDustNote } from '../lib/grant/deploy-cost.ts';
import { type OwnerCommandOutput, grantRequestOf, grantsOf, issue, issuePreview, revoke, revokeAll, statusOf } from '../lib/grant/owner-commands.ts';
import { prepareGrant } from '../lib/grant/prepare.ts';
import { type GrantRequest, paysAFee } from '../lib/grant/request.ts';
import { type PayingWallet, openPayingWallet } from '../lib/grant/fee-wallet.ts';

const SPINNER_LABEL: Record<GrantRequest['subcommand'], string> = {
  deploy: 'Deploying the account...',
  deposit: 'Depositing into the account...',
  status: 'Reading the account...',
  list: 'Reading the grants...',
  issue: 'Reading the grant request...',
  revoke: 'Revoking the grant...',
  'revoke-all': 'Revoking every grant...',
  export: 'Writing the backup...',
  import: 'Importing the backup...',
  device: 'Working on the account\'s devices...',
};

/** Whether the failure is a shortage of Dust or NIGHT, by the code it carries. */
function isShortOfDust(err: Error): boolean {
  const { code } = err as { code?: unknown };
  return code === 'DUST_REQUIRED' || code === 'INSUFFICIENT_BALANCE';
}

/** A deposit is refused before anything is built when the wallet's synced shielded NIGHT is short: the SDK's own refusal names neither the token nor the amounts. */
function shortOfShieldedNight(held: bigint, value: bigint): UsageError {
  return new UsageError(
    `Not enough shielded NIGHT for this deposit: the wallet holds ${formatNight(held)} shielded and the deposit takes ${formatNight(value)}. `
    + 'Get shielded NIGHT into it first: midnight airdrop <amount> --shielded on a local chain, or midnight transfer <this wallet> <amount> --shielded from another wallet.',
  );
}

/** The same refusal for a deposit of another token, by its raw type, both amounts in its smallest unit. */
function shortOfShieldedToken(token: string, held: bigint, value: bigint): UsageError {
  return new UsageError(
    `Not enough of token ${token} for this deposit: the wallet holds ${held} of it shielded and the deposit takes ${value}, in the token's smallest unit. `
    + 'midnight balance lists the wallet\'s shielded tokens by their raw type, with what it holds of each.',
  );
}

export default async function grantCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const { request, target, walletName, recordsDir, account } = await prepareGrant(args, ctx.config.paths.stateRoot, ctx.host);
  const jsonMode = hasFlag(args, 'json');
  const walletFlag = getFlag(args, 'wallet');
  const spinnerFor = (label: string): Spinner => (jsonMode ? ctx.progress.silent() : ctx.progress.start(label));

  if (!jsonMode) {
    ctx.output.stderr('\n' + header(`Grant: ${request.subcommand}`) + '\n\n');
    ctx.output.stderr(keyValue('Network', target.network) + '\n');
    ctx.output.stderr(keyValue('Wallet', walletName) + '\n');
    if (account !== null) ctx.output.stderr(keyValue('Account', account.address) + '\n');
    ctx.output.stderr('\n');
  }

  // Reading the account or a request submits nothing: a wallet with no Dust can still do it, and none is opened.
  const payer = paysAFee(request) ? payerFor(`grant ${request.subcommand}`, ctx) : undefined;
  const funds = payer ? await payer.assertCanPay(target, walletFlag, spinnerFor('Checking wallet...'), ctx.signal, `grant ${request.subcommand}`) : undefined;
  const paying = payer ? await openPayingWallet(payer, target, (await accountChainFor(ctx.host.engines, target.network)).connector, walletFlag, spinnerFor('Opening the wallet...'), ctx.sdkWarnings, ctx.signal, request.subcommand === 'deposit' ? { shielded: true } : undefined) : undefined;
  try {
    await runOwned(request, { target, walletName, recordsDir, account, jsonMode, paying, funds, spinnerFor }, ctx);
  } finally {
    await paying?.stop();
  }
}

interface OwnedRun {
  target: Awaited<ReturnType<typeof prepareGrant>>['target'];
  walletName: string;
  recordsDir: string;
  account: Awaited<ReturnType<typeof prepareGrant>>['account'];
  jsonMode: boolean;
  paying: PayingWallet | undefined;
  funds: { dustBalance: bigint } | undefined;
  spinnerFor: (label: string) => Spinner;
}

/** Runs the command on the account, with the wallet that pays (if it pays) already open. */
async function runOwned(request: GrantRequest, { target, walletName, recordsDir, account, jsonMode, paying, funds, spinnerFor }: OwnedRun, ctx: CallContext): Promise<void> {
  const spinner = spinnerFor(SPINNER_LABEL[request.subcommand]);
  // This machine's device, made where no account is yet: it opens no account first.
  if (request.subcommand === 'device' && request.action === 'new') {
    const { createPendingDevice, openAccountKey, ownJoinCode } = await import('../lib/grant/sealed-account.ts');
    const { unlockPassphrase, passphraseForNewSecret, isPassphraseSet } = await import('@kuiralabs/midnight-wallet');
    const passphrase = isPassphraseSet(target.root) ? await unlockPassphrase(ctx.host, target.root) : await passphraseForNewSecret(ctx.host, target.root);
    const { owner } = await accountChainFor(ctx.host.engines, target.network);
    const device = createPendingDevice(recordsDir, passphrase, owner);
    const code = ownJoinCode(recordsDir, openAccountKey(recordsDir, passphrase), device);
    spinner.stop('Device ready');
    if (jsonMode) {
      ctx.output.result({ subcommand: 'device', action: 'new', network: target.network, wallet: walletName, ownerKey: 'sealed', code });
    } else {
      ctx.output.stderr('\n' + dim('  On a machine already an owner of the account, run:') + '\n');
      ctx.output.stderr(dim(`  midnight grant device add ${code} --backup <file>`) + '\n');
      ctx.output.stderr(dim('  then bring that file here: midnight grant import <file>') + '\n');
      ctx.output.stderr(dim('  The code is signed afresh each time it is shown; any of them adds this device.') + '\n\n');
      ctx.output.stdout(code + '\n');
    }
    return;
  }
  // An import brings an account in where there is none: it opens no account first.
  if (request.subcommand === 'import') {
    const { importAccount } = await import('../lib/grant/account-backup.ts');
    const { unlockPassphrase, passphraseForNewSecret, isPassphraseSet } = await import('@kuiralabs/midnight-wallet');
    try {
      const passphrase = isPassphraseSet(target.root) ? await unlockPassphrase(ctx.host, target.root) : await passphraseForNewSecret(ctx.host, target.root);
      const { contractAddress } = await importAccount(recordsDir, target.network, passphrase, request.file, ctx.host.engines);
      spinner.stop('Imported');
      if (jsonMode) ctx.output.result({ subcommand: request.subcommand, network: target.network, wallet: walletName, ownerKey: 'sealed', address: contractAddress });
      else ctx.output.stderr('\n' + keyValue('Account', contractAddress) + '\n' + dim('  Use it from one machine at a time: this machine now acts as the same owner device.') + '\n\n');
    } catch (err) {
      spinner.fail('import failed');
      throw err;
    }
    return;
  }
  // A cancel takes effect at the next step the account package reports: each
  // step it records before submitting, so stopping there is as safe as an
  // interruption, and the next run finishes what this one left.
  // Where the account contract's proving artefacts come from: MN_ACCOUNT_ARTIFACTS, the config key, or the build's release.
  const artefacts = resolveAccountArtifactsSource(ctx.config.settings, loadCliConfig(target.root));
  const owned: GrantAccount = await openGrantAccount(target.networkConfig, recordsDir, (line) => {
    spinner.update(line);
    throwIfCancelled(ctx.signal);
  }, { root: target.root, host: ctx.host, artefacts });
  // How the account's owner key and records are kept: sealed, or in plain text until `wallet protect`.
  const common = { subcommand: request.subcommand, network: target.network, wallet: walletName, ownerKey: owned.protection };

  // The wallet that pays, which a paying command opened above.
  const payingWallet = async (): Promise<PayingWallet> => {
    if (paying === undefined) throw new Error(`${request.subcommand} was prepared as a command that pays nothing`);
    throwIfCancelled(ctx.signal);
    return paying;
  };
  // A payment, run again at the wallet's larger margin when the node refused its fee as too low.
  const paid = async <T>(pay: () => Promise<T>): Promise<T> => (await payingWallet()).repricing(pay, (message) => spinner.update(message), ctx.signal);
  // The owner's session, paid by the wallet.
  const ownerSession = async () => {
    const { connectOver, openSessionOver } = owned.chain.owner;
    if (account === null) throw new Error('An owner command was prepared without an account');
    const { feeWallet } = await payingWallet();
    // A sealed account's device reads the owner-device mailbox: it catches up on another device's rotation, and is listed for later ones.
    return openSessionOver(await connectOver(owned.context, account.address, feeWallet, owned.location, async () => {}), owned.store, ownerDeviceOf(owned), { deviceReadSecret: owned.deviceReadSecret?.() });
  };
  const report = (output: OwnerCommandOutput): void => {
    spinner.stop('Done');
    if (jsonMode) {
      ctx.output.result({ ...common, ...output.result });
    } else {
      ctx.output.stderr('\n');
      ctx.output.stdout(output.lines.join('\n') + '\n\n');
    }
  };

  try {
    throwIfCancelled(ctx.signal);
    switch (request.subcommand) {
      case 'deploy': {
        const { deployOwnerAccount, freshOwnerDevice } = owned.chain.owner;
        const { feeWallet } = await payingWallet();
        // The device the records hold, or for a new account a key made here, on the k1 arm and
        // independent of any other (MIP-0013), kept sealed before the deploy is submitted.
        const device = () => owned.keys.read() ?? owned.keys.keep(freshOwnerDevice('k1'));
        // Run again after a refused fee, the account package carries on from the step it recorded.
        const outcome = await paid(() => deployOwnerAccount(owned.context, feeWallet, owned.store, owned.location, device));
        spinner.stop(outcome.resumed ? 'Account ready' : 'Account deployed');
        if (jsonMode) {
          ctx.output.result({ ...common, ...outcome });
        } else {
          ctx.output.stderr('\n' + keyValue('Account', outcome.address) + '\n');
          if (outcome.resumed) ctx.output.stderr(dim('  An account already on record was completed; no new one was deployed.') + '\n');
          if (outcome.setAside) ctx.output.stderr(dim(`  The record of an earlier deploy that never reached the chain was kept at ${outcome.setAside}`) + '\n');
          if (owned.protection === 'sealed') ctx.output.stderr('\n' + dim('  Its owner key was made on this machine and is kept encrypted under mn\'s passphrase.') + '\n');
          ctx.output.stderr(dim('  Next: midnight grant status') + '\n\n');
          ctx.output.stdout(outcome.address + '\n');
        }
        return;
      }
      case 'deposit': {
        const { connectOver, depositShielded } = owned.chain.deposit;
        if (account === null) throw new Error('A deposit was prepared without an account');
        const wallet = await payingWallet();
        const { token } = request;
        const value = BigInt(request.value);
        const held = await wallet.shieldedBalance(token ?? NATIVE_TOKEN_TYPE);
        if (held < value) throw token === undefined ? shortOfShieldedNight(held, value) : shortOfShieldedToken(token, held, value);
        const { result } = await paid(async () => {
          const connection = await connectOver(owned.context, account.address, wallet.feeWallet, owned.location, async () => {});
          // NIGHT is the package's default color; another token's color is its raw type's 32 bytes.
          return token === undefined ? depositShielded(connection, value) : depositShielded(connection, value, new Uint8Array(Buffer.from(token, 'hex')));
        });
        const outcome = { address: account.address, value: request.value, ...(token === undefined ? {} : { token }), txHash: result.public.txHash, blockHeight: Number(result.public.blockHeight) };
        spinner.stop('Deposited');
        if (jsonMode) {
          ctx.output.result({ ...common, amount: request.amount, ...outcome });
        } else {
          const deposited = token === undefined
            ? `${request.amount} NIGHT (${outcome.value} in the smallest unit, as status and --cap count)`
            : `${request.amount} of token ${token}, in its smallest unit`;
          ctx.output.stderr('\n' + keyValue('Deposited', deposited) + '\n');
          ctx.output.stderr(keyValue('Block', String(outcome.blockHeight)) + '\n');
          ctx.output.stderr(keyValue('Transaction', outcome.txHash) + '\n');
          ctx.output.stderr('\n' + dim('  Next: midnight grant status') + '\n\n');
          ctx.output.stdout(outcome.txHash + '\n');
        }
        return;
      }
      case 'status':
      case 'list': {
        const { readOwnerView } = owned.chain.owner;
        const device = ownerDeviceOf(owned);
        const view = await readOwnerView(owned.context.network, owned.store, device);
        const code = owned.ownCode?.() ?? 'none until the account is protected (midnight wallet protect)';
        report(request.subcommand === 'status' ? statusOf(view, device.arm, code) : grantsOf(view, owned.context.clock(), owned.chain));
        return;
      }
      case 'issue': {
        const grantRequest = grantRequestOf(request.link);
        if (!request.confirmed) {
          report(issuePreview(grantRequest, request.limits, owned.context.clock(), owned.chain));
          return;
        }
        report(await paid(async () => issue(await ownerSession(), grantRequest, request.limits, owned.context.clock(), owned.chain)));
        return;
      }
      case 'revoke':
        report(await paid(async () => revoke(await ownerSession(), request.target, owned.chain)));
        return;
      case 'revoke-all':
        report(await paid(async () => revokeAll(await ownerSession(), owned.chain)));
        return;
      case 'device': {
        if (owned.protection !== 'sealed') throw new UsageError('The account is not protected: its devices are managed once it is. Encrypt it first: midnight wallet protect');
        const { openAccountKey, sealedDeviceList } = await import('../lib/grant/sealed-account.ts');
        const { unlockPassphrase } = await import('@kuiralabs/midnight-wallet');
        const passphrase = await unlockPassphrase(ctx.host, target.root);
        const devices = sealedDeviceList(recordsDir, openAccountKey(recordsDir, passphrase));
        if (owned.ownCode === undefined) throw new Error('A sealed account names its own device code');
        const own = owned.ownCode();
        const known = devices.read().length > 0 ? devices.read() : [own];
        if (request.action === 'list') {
          spinner.stop('Done');
          if (jsonMode) ctx.output.result({ ...common, action: 'list', devices: known.map((code) => ({ code, thisMachine: code === own })) });
          else ctx.output.stdout(known.map((code) => `${code}${code === own ? '  (this machine)' : ''}`).join('\n') + '\n\n');
          return;
        }
        const named = parseDeviceCode(request.code);
        if (request.action === 'add') {
          const { addOwnerDevice } = owned.chain.owner;
          const { exportAccount } = await import('../lib/grant/account-backup.ts');
          if (named.arm !== 'v1') throw new UsageError('The account adds JubJub devices only (a v1 device code, as midnight grant device new makes).');
          if (named.attestation === undefined) {
            throw new UsageError('This device code carries no signature of its read key, which the account\'s other devices need. Show the code again on the new device (midnight grant device new prints it).');
          }
          // The backup is checked before the device is added, so the add never lands with nowhere to write it.
          if (request.backup !== undefined && existsSync(request.backup)) throw new UsageError(`${request.backup} already exists; a backup is never written over a file.`);
          const { attestation } = named;
          await paid(async () => addOwnerDevice(await ownerSession(), attestation));
          const added = identityCodeOf(request.code);
          devices.write([...known.filter((code) => identityCodeOf(code) !== added), added]);
          const written = request.backup === undefined ? undefined : await exportAccount(recordsDir, target.network, passphrase, request.backup, ctx.host.engines, { forDevice: named });
          spinner.stop('Device added');
          if (jsonMode) {
            ctx.output.result({ ...common, action: 'add', code: added, ...(written === undefined ? {} : { backup: written.file }) });
          } else {
            ctx.output.stderr('\n' + keyValue('Added', added) + '\n' + (written === undefined ? '' : keyValue('Backup', written.file) + '\n'));
            ctx.output.stderr(dim('  The account was sealed to the new device on chain: its secret, the devices\' read keys and every live grant.') + '\n');
            if (written !== undefined) ctx.output.stderr(dim('  For another mn: midnight grant import <that file>. It opens with mn\'s passphrase.') + '\n');
            ctx.output.stderr('\n');
          }
          return;
        }
        const { removeOwnerDevice } = owned.chain.owner;
        const removing = identityCodeOf(request.code);
        if (removing === own) throw new UsageError('A device does not remove itself: remove this one from another device on the account.');
        const { removed } = await paid(async () => removeOwnerDevice(await ownerSession(), deviceKeyOf(named), named.readKey));
        devices.write(known.filter((code) => identityCodeOf(code) !== removing));
        spinner.stop(removed ? 'Device removed' : 'Already removed');
        if (jsonMode) ctx.output.result({ ...common, action: 'remove', code: request.code, removed });
        else ctx.output.stderr('\n' + keyValue(removed ? 'Removed' : 'Already removed', request.code) + '\n' + dim('  The account\'s encryption key was rotated after, away from the removed device.') + '\n\n');
        return;
      }
      case 'export': {
        const { exportAccount } = await import('../lib/grant/account-backup.ts');
        const { unlockPassphrase } = await import('@kuiralabs/midnight-wallet');
        const outcome = await exportAccount(recordsDir, target.network, await unlockPassphrase(ctx.host, target.root), request.file, ctx.host.engines);
        spinner.stop('Written');
        if (jsonMode) {
          ctx.output.result({ ...common, address: outcome.contractAddress, file: outcome.file });
        } else {
          ctx.output.stderr('\n' + keyValue('Backup', outcome.file) + '\n');
          ctx.output.stderr(dim('  It opens only with mn\'s passphrase. Keep it, and the passphrase, apart from this machine.') + '\n\n');
        }
        return;
      }
    }
  } catch (err) {
    spinner.fail(`${request.subcommand} failed`);
    // A deploy costs far more Dust than a transfer: say how much when that is what stopped it.
    // With the note, the failure is a Dust shortage: DUST_REQUIRED, as the note's words always made it.
    if (request.subcommand === 'deploy' && funds !== undefined && err instanceof Error && isShortOfDust(err)) {
      throw new DustRequiredError(`${err.message}\n\n${deployShortOfDustNote(funds.dustBalance)}`, { cause: err });
    }
    // A proving key of the account contract it couldn't fetch: named, with the build's.
    const keys = accountKeysFailureOf(err, owned.chain, artefacts);
    if (keys !== undefined) throw keys;
    // The account package reaches the indexer and the proof server itself, past the engine: a connection it couldn't make is a network error.
    throw withTransportCode(err);
  }
}
