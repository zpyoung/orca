import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const HEIMDALL_MANAGE_SPECS: CommandSpec[] = [
  {
    path: ['heimdall', 'list'],
    summary: 'List Heimdall watchers across owners',
    usage: 'orca heimdall list [--kind <objective|hosted-review>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'kind', 'worktree'],
    examples: ['orca heimdall list', 'orca heimdall list --json']
  },
  {
    path: ['heimdall', 'show'],
    summary: 'Show a watcher, its ledger, traces, and workers',
    usage: 'orca heimdall show <watcherId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id'],
    positionalArgs: ['watcher-id'],
    examples: ['orca heimdall show watcher_01J000000000000000000000']
  },
  {
    path: ['heimdall', 'objective'],
    summary: 'Show an objective watcher plan and progress',
    usage: 'orca heimdall objective <watcherId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id'],
    positionalArgs: ['watcher-id'],
    examples: ['orca heimdall objective watcher_01J000000000000000000000']
  },
  {
    path: ['heimdall', 'pause'],
    summary: 'Pause a Heimdall watcher',
    usage: 'orca heimdall pause <watcherId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id'],
    positionalArgs: ['watcher-id'],
    examples: ['orca heimdall pause watcher_01J000000000000000000000']
  },
  {
    path: ['heimdall', 'resume'],
    summary: 'Resume a paused Heimdall watcher',
    usage: 'orca heimdall resume <watcherId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id'],
    positionalArgs: ['watcher-id'],
    examples: ['orca heimdall resume watcher_01J000000000000000000000']
  },
  {
    path: ['heimdall', 'disarm'],
    summary: 'Disable a Heimdall watcher',
    usage: 'orca heimdall disarm <watcherId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id'],
    positionalArgs: ['watcher-id'],
    examples: ['orca heimdall disarm watcher_01J000000000000000000000']
  },
  {
    path: ['heimdall', 'rm'],
    summary: 'Permanently remove a Heimdall watcher',
    usage: 'orca heimdall rm <watcherId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id'],
    positionalArgs: ['watcher-id'],
    destructive: true,
    notes: ['Permanently deletes the watcher and its control record on its owner.'],
    examples: ['orca heimdall rm watcher_01J000000000000000000000']
  },
  {
    path: ['heimdall', 'approve'],
    summary: 'Approve a specific unresolved watcher approval',
    usage: 'orca heimdall approve <watcherId> <escalationId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'escalation-id'],
    positionalArgs: ['watcher-id', 'escalation-id'],
    examples: ['orca heimdall approve watcher_01J000000000000000000000 escalation_1']
  },
  {
    path: ['heimdall', 'answer'],
    summary: 'Answer a worker question',
    usage: 'orca heimdall answer <watcherId> <messageId> --body <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'message-id', 'body'],
    positionalArgs: ['watcher-id', 'message-id'],
    examples: [
      'orca heimdall answer watcher_01J000000000000000000000 msg_1 --body "Use the new API"'
    ]
  },
  {
    path: ['heimdall', 'answer-escalation'],
    summary: 'Answer a parked owner escalation',
    usage: 'orca heimdall answer-escalation <watcherId> <escalationId> --body <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'escalation-id', 'body'],
    notes: ['Answers only the owner escalation on which the watcher is currently parked.'],
    positionalArgs: ['watcher-id', 'escalation-id'],
    examples: [
      'orca heimdall answer-escalation watcher_01J000000000000000000000 owner-deviation:... --body "Use the new API"'
    ]
  },
  {
    path: ['heimdall', 'stop-worker'],
    summary: 'Stop a dispatched worker',
    usage: 'orca heimdall stop-worker <watcherId> <dispatchId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'dispatch-id'],
    positionalArgs: ['watcher-id', 'dispatch-id'],
    examples: ['orca heimdall stop-worker watcher_01J000000000000000000000 dispatch_1']
  },
  {
    path: ['heimdall', 'budget'],
    summary: 'Change one or both watcher budget limits',
    usage: 'orca heimdall budget <watcherId> [--hours <n|none>] [--turns <n|none>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'hours', 'turns'],
    positionalArgs: ['watcher-id'],
    notes: [
      'Hours and turns are merged with the current policy when omitted; use none to remove a limit.'
    ],
    examples: [
      'orca heimdall budget watcher_01J000000000000000000000 --hours 2',
      'orca heimdall budget watcher_01J000000000000000000000 --hours none --turns 5'
    ]
  },
  {
    path: ['heimdall', 'set-concurrency'],
    summary: 'Change a live objective watcher concurrency cap',
    usage: 'orca heimdall set-concurrency <watcherId> <maxConcurrency> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'max-concurrency'],
    positionalArgs: ['watcher-id', 'max-concurrency'],
    notes: [
      'Lowering the cap lets in-flight dispatches finish; raising it takes effect on the next watcher tick.',
      'Folder workspaces remain capped at 1.'
    ],
    examples: ['orca heimdall set-concurrency watcher_01J000000000000000000000 3']
  },
  {
    path: ['heimdall', 'debug'],
    summary: 'Collect a watcher debug report',
    usage: 'orca heimdall debug <watcherId> [--json] [--out <path>]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'out'],
    positionalArgs: ['watcher-id'],
    notes: [
      'The report always prints as bare JSON, with or without --json.',
      '--out writes the same JSON to a path on the machine running this CLI.'
    ],
    examples: [
      'orca heimdall debug watcher_01J000000000000000000000',
      'orca heimdall debug watcher_01J000000000000000000000 --out ./heimdall-report.json'
    ]
  }
]
