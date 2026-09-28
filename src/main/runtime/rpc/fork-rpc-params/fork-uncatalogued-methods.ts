/** Fork-owned RPC methods whose params schema has no shared-contract entry, and
 *  the two upstream methods the project-ledger feature extends with a main-side
 *  schema. Kept beside upstream's own list so the gap stays visible rather than
 *  absent; `generate:rpc-params-catalog` writes the matching runtime array. */
export type ForkUncataloguedMethod =
  | 'artifacts.publishProtected'
  | 'artifacts.removeProtection'
  | 'artifacts.rotateProtection'
  | 'artifacts.shareProtected'
  | 'ask.answer'
  | 'ask.cancel'
  | 'ask.register'
  | 'ask.snapshot'
  | 'ask.subscribe'
  | 'ask.updatePartial'
  | 'ask.wait'
  | 'heimdall:approve'
  | 'heimdall:debugReport'
  | 'heimdall:disarm'
  | 'heimdall:disarmAll'
  | 'heimdall:enroll'
  | 'heimdall:ledger'
  | 'heimdall:list'
  | 'ledger.request'
  | 'ledger.ui'
  | 'projectGroup.delete'
  | 'repo.rm'
