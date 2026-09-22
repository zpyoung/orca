export const HEIMDALL_COMMANDS_RUNTIME_CAPABILITY = 'heimdall.commands.v1' as const
// Why: delete extends the strict Heimdall command union and is destructive. Clients must not send
// it to an older host that only advertises the original commands capability.
export const HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY = 'heimdall.watcher-delete.v1' as const
// Why: a new DispatchResult refusal reason is persisted inside ledger rows. Servers must project
// that optional result away unless the paired reader explicitly advertises the expanded enum.
export const HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY =
  'heimdall.dispatch-result-pre-dispatch-failure.v1' as const
// Why: WatcherParkReason grew worker-escalation and configuration-error members. A reader whose
// compiled schema predates them fails to parse the whole status on the unrecognized discriminant,
// so servers must degrade those two kinds to null by default and publish them only when negotiated.
export const HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY =
  'heimdall.watcher-park-reason.v2' as const
// Why: EnrollInput's owner fields ride a `.strict()` request schema, so an old host's compiled
// schema rejects the unrecognized keys outright. A client must confirm the owning runtime
// advertises this before including them, the same way it gates heimdall.commands.v1.
export const HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY = 'heimdall.enroll-owner.v1' as const
// Why: objective enrollment adds a strict lanes field and raises the usable concurrency cap.
// Clients clamp and strip both when this capability is absent so old hosts still enroll in place.
export const HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY =
  'heimdall.parallel-execution.v1' as const
export const HEIMDALL_PARALLEL_EXECUTION_UNSUPPORTED_NOTE =
  'This host does not support parallel objective execution yet; the watcher runs in place.'
