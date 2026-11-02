// The router of the SDK's warnings to the calls they came from. The
// shell's filters, which tag a warning with the call that raised it, are
// tested in a process of their own (process-safety.test.ts).

import { describe, it, expect } from 'vitest';
import { createSdkWarningRouter, sdkTransientWarning, sdkWarningCallsOn } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';

describe('the SDK-warning router', () => {
  it('gives a warning with a call\'s identity to that call\'s newest listener, and no other call\'s', () => {
    const router = createSdkWarningRouter();
    const a = router.openCall();
    const b = router.openCall();
    const said: string[] = [];
    a.warnings.listen((tag, message) => said.push(`a outer ${tag} ${message}`));
    const stopInner = a.warnings.listen((_tag, message) => said.push(`a inner ${message}`));
    b.warnings.listen((_tag, message) => said.push(`b ${message}`));
    router.route(a.id, 'Wallet.Sync', 'one');
    stopInner();
    router.route(a.id, 'Wallet.Sync', 'two');
    router.route(b.id, 'Wallet.Sync', 'three');
    expect(said).toEqual(['a inner one', 'a outer Wallet.Sync two', 'b three']);
  });

  it("gives a warning from a call that isn't listening to no one, though another call listens", () => {
    const router = createSdkWarningRouter();
    const a = router.openCall();
    const b = router.openCall();
    const said: string[] = [];
    b.warnings.listen((_tag, message) => said.push(`b ${message}`));
    a.warnings.listen(undefined)();
    router.route(a.id, 'Wallet.Sync', 'after a stopped');
    expect(said).toEqual([]);
    expect(router.isListening()).toBe(true);
  });

  it('gives a warning without an identity to the one call listening', () => {
    const router = createSdkWarningRouter();
    const a = router.openCall();
    router.openCall(); // opened, never listening
    const said: string[] = [];
    a.warnings.listen((_tag, message) => said.push(`a ${message}`));
    router.route(undefined, 'Wallet.Sync', 'from nowhere');
    expect(said).toEqual(['a from nowhere']);
  });

  it('gives a warning without an identity to none when several calls listen', () => {
    const router = createSdkWarningRouter();
    const said: string[] = [];
    router.openCall().warnings.listen((_tag, message) => said.push(`a ${message}`));
    router.openCall().warnings.listen((_tag, message) => said.push(`b ${message}`));
    router.route(undefined, 'Wallet.Sync', 'from nowhere');
    expect(said).toEqual([]);
    expect(router.isListening()).toBe(true);
  });

  it('listens while some call has a listener, and stops when the last one goes; a stop given twice stops once', () => {
    const router = createSdkWarningRouter();
    const call = router.openCall();
    expect(router.isListening()).toBe(false);
    const stopFirst = call.warnings.listen(undefined);
    const stopSecond = call.warnings.listen(undefined);
    stopFirst();
    stopFirst();
    expect(router.isListening()).toBe(true);
    stopSecond();
    expect(router.isListening()).toBe(false);
  });

  it('gives each call it runs its own warnings, which carry no identity', async () => {
    const router = createSdkWarningRouter();
    const calls = sdkWarningCallsOn(router);
    const said: string[] = [];
    const stop = await calls.run(async (warnings) => warnings.listen((_tag, message) => said.push(message)));
    router.route(undefined, 'Wallet.Sync', 'kept to the one call listening');
    stop();
    expect(said).toEqual(['kept to the one call listening']);
    expect(router.isListening()).toBe(false);
  });
});

describe('sdkTransientWarning', () => {
  it('reads a Wallet.* error, its string trace, and nothing else', () => {
    expect(sdkTransientWarning({ _tag: 'Wallet.Sync', message: 'Internal Server Error' })).toEqual({ tag: 'Wallet.Sync', message: 'Internal Server Error' });
    expect(sdkTransientWarning({ _tag: 'Wallet.Sync' })).toEqual({ tag: 'Wallet.Sync', message: 'transient error' });
    expect(sdkTransientWarning('Wallet.Sync: Internal Server Error\n    at somewhere')).toEqual({ tag: 'Wallet.Sync', message: 'transient error' });
    expect(sdkTransientWarning({ _tag: 'Other.Error', message: 'no' })).toBeNull();
    expect(sdkTransientWarning(new Error('plain'))).toBeNull();
    expect(sdkTransientWarning('a real problem')).toBeNull();
  });
});
