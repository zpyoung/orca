import { GLOBAL_FLAGS, type CommandSpec } from '../args'

/** CommandSpec entries for `orca ask` / `orca ask wait` / `orca ask cancel` (tech.md C5). */
export const ASK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['ask'],
    summary: 'Ask the user a question and block until answered',
    usage: 'orca ask --spec <json|@file> [--timeout-ms <n>] [--chunk-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'spec', 'timeout-ms', 'chunk-ms'],
    notes: [
      'The envelope always prints as bare JSON on stdout, with or without --json, because the consumer is always a model.',
      'Prints {"status":"registered","id":"..."} immediately, then blocks for one chunk before printing the result.',
      'If the ask is still unanswered at the chunk boundary, resume with `orca ask wait --id <id>`.'
    ],
    examples: [
      'orca ask --spec \'{"questions":[{"id":"db","type":"select","question":"Which database?","options":[{"value":"postgres","label":"PostgreSQL"}]}]}\'',
      'orca ask --spec @question.json --timeout-ms 60000'
    ]
  },
  {
    path: ['ask', 'wait'],
    summary: 'Resume blocking on a pending ask',
    usage: 'orca ask wait --id <ask_id> [--chunk-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'chunk-ms'],
    examples: ['orca ask wait --id ask_01J000000000000000000000']
  },
  {
    path: ['ask', 'cancel'],
    summary: 'Cancel a pending ask as declined',
    usage: 'orca ask cancel --id <ask_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['orca ask cancel --id ask_01J000000000000000000000']
  }
]
