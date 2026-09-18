export const HEIMDALL_COMMANDS_RUNTIME_CAPABILITY = 'heimdall.commands.v1' as const
// Why: a new DispatchResult refusal reason is persisted inside ledger rows. Servers must project
// that optional result away unless the paired reader explicitly advertises the expanded enum.
export const HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY =
  'heimdall.dispatch-result-pre-dispatch-failure.v1' as const
