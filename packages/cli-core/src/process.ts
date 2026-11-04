// @kuiralabs/midnight-cli-core/process: what a host does to its own process
// for the wallet SDK, and the only code in the packages that touches the
// process. Nothing here runs on import, and no package imports it: a host
// calls it. The guard against the SDK's transient rejections (and, as an
// option, its console noise), and the heap a cold wallet sync needs.

export { installSdkProcessGuard, type SdkProcessGuard, type SdkProcessGuardOptions } from './process/sdk-process-guard.ts';
export { type SyncHeapAdvice, syncHeapAdvice, syncHeapTargetMb, type SyncHeapTargetOptions } from './process/sync-heap.ts';
