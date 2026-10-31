// The SDK's fork schedule for the chains this build targets, which the
// wallet facade read chains by.
//
// The beta SDK set (wallet-sdk-facade 5.0.0-beta.2, abstractions 3.0.0-beta.0)
// has no fork schedule: no `ProtocolVersion.ForkSchedule`, no
// `V9NativeForkSchedule`, and each wallet has one ledger-9 variant. Nothing
// here is used on this branch; the file is kept until its removal is approved.

export {};
