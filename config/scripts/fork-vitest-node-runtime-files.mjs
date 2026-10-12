// Fork tests that open real SQLite databases, so they run in the Node runtime project.
export const FORK_NODE_RUNTIME_INCLUDE = [
  'src/main/fork-automation-launch-settings/persistence-automations.test.ts',
  'src/main/fork-heimdall-objective/objective-database.test.ts',
  'src/main/fork-heimdall/database.test.ts',
  'src/main/fork-heimdall/ledger-store.test.ts',
  'src/main/fork-heimdall/orchestration/question-answer.test.ts',
  'src/main/runtime/rpc/methods/fork-heimdall/orchestration-federated-submission-preflight.test.ts'
]
