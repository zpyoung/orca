import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const HEIMDALL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['heimdall', 'debug'],
    summary: 'Collect a watcher debug report',
    usage: 'orca heimdall debug <watcherId> [--json] [--out <path>]',
    allowedFlags: [...GLOBAL_FLAGS, 'watcher-id', 'out'],
    positionalArgs: ['watcher-id'],
    notes: [
      'The report always prints as bare JSON, with or without --json.',
      'This command targets watchers owned by the local Orca kernel; remote connection targeting is not supported.',
      '--out writes the same JSON to a path on the machine running this CLI.'
    ],
    examples: [
      'orca heimdall debug watcher_01J000000000000000000000',
      'orca heimdall debug watcher_01J000000000000000000000 --out ./heimdall-report.json'
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
    examples: [
      'orca heimdall set-concurrency watcher_01J000000000000000000000 3',
      'orca heimdall set-concurrency watcher_01J000000000000000000000 1 --json'
    ]
  }
]
