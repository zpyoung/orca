export const HEIMDALL_COMMANDS_RUNTIME_CAPABILITY = 'heimdall.commands.v1' as const
// Why: delete extends the strict Heimdall command union and is destructive. Clients must not send
// it to an older host that only advertises the original commands capability.
export const HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY = 'heimdall.watcher-delete.v1' as const
// Why: humanReply rides a new strict command and a new EscalationEntry field. Clients must not send
// answer-escalation to an older host, and servers must strip humanReply from readers that lack it.
export const HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY =
  'heimdall.watcher-answer-escalation.v1' as const
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
// Why: roleLaunch rides the same strict objective enrollment schema, so an old host's compiled
// schema rejects it outright unless a client confirms this capability first.
export const HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY =
  'heimdall.objective-role-launch.v1' as const
// Why: the host derives branch/provider/review identity into persisted enrollment payloads. Clients
// may omit those candidate fields only after confirming this runtime capability.
export const HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY =
  'heimdall.hosted-review-derived-payload.v1' as const
// Why: an old host rejects newWorktree in the strict objective payload; clients must refuse rather than strip it.
export const HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY =
  'heimdall.objective-new-worktree.v1' as const
/** Wire-shape capabilities every remote client advertises so hosts publish Heimdall's newer fields. */
export const HEIMDALL_REMOTE_CLIENT_CAPABILITIES = [
  HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
] as const
