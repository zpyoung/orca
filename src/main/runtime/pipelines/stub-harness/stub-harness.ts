/** Public API of the deterministic stub harness — a test-only, scriptable stand-in agent. */

export {
  resolveStubAgentRunnerPath,
  buildStubAgentCmdOverride,
  STUB_AGENT_AWAIT_PASTE_ENV_VAR
} from './stub-agent-launcher'
export { createStubHarnessControlDir, StubHarnessTimeoutError } from './stub-harness-control-dir'
export {
  writeStubInvocationScript,
  type StubInvocationScript,
  type StubFileWrite
} from './stub-harness-script'
export {
  waitForStubOutcome,
  readStubOutcomeIfPresent,
  type StubInvocationOutcome
} from './stub-harness-outcome'
export { waitForStubHold, isStubHolding, releaseStubHold } from './stub-harness-hold-signal'
export { readStubReceivedPrompt, readStubReceivedArgv } from './stub-harness-received-prompt'
