import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const CREATE_FLAGS = [
  'worktree',
  'name',
  'agent',
  'preset',
  'prompt',
  'queue-item',
  'repeat-queue',
  'every',
  'anchor',
  'session',
  'check',
  'check-timeout',
  'check-when',
  'evaluator',
  'max-iterations',
  'max-minutes',
  'max-cost',
  'no-progress',
  'protected-path',
  'checkpoint-commits',
  'ask-before-next',
  'resume-at-reset'
]

const EDIT_FLAGS = CREATE_FLAGS.filter(
  (flag) => !['worktree', 'agent', 'preset', 'queue-item'].includes(flag)
)

export const LOOP_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['loop', 'create'],
    summary: 'Start an agent loop in a worktree',
    usage:
      'orca loop create --agent <agent> [--worktree <selector>] [--name <name>] [--preset until-done|interval|queue] (--prompt <text> | --queue-item <text>...) [--repeat-queue] [--every <minutes>] [--anchor from-end|wall-clock] [--session fresh|continue] [--check <command>] [--check-timeout <seconds>] [--check-when every-iteration|on-claim] [--evaluator <condition>] [--max-iterations <n>] [--max-minutes <n>] [--max-cost <usd>] [--no-progress] [--protected-path <glob>]... [--checkpoint-commits] [--ask-before-next] [--resume-at-reset] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...CREATE_FLAGS],
    repeatableFlags: ['queue-item', 'protected-path'],
    notes: [
      'Defaults to the current worktree. The loop runs in the Orca app, so it keeps going after this command returns.',
      'until-done repeats --prompt whenever the agent goes idle; interval repeats it every --every minutes; queue sends each --queue-item once, in order.',
      'The check command, the evaluator condition, or both decide when the loop is done. The agent printing DONE only counts as a claim.',
      'Omit the --max-* flags and the loop has no cap on that measure.',
      'Boolean flags default to off; pass --flag=false to be explicit.'
    ],
    examples: [
      'orca loop create --agent claude --prompt "Fix the failing tests" --check "pnpm test" --max-iterations 10',
      'orca loop create --agent codex --preset interval --every 10 --prompt "Check the PR" --check "gh pr checks" --max-minutes 480',
      'orca loop create --agent claude --preset queue --queue-item "Add the endpoint" --queue-item "Write its tests"'
    ]
  },
  {
    path: ['loop', 'list'],
    summary: 'List loops',
    usage: 'orca loop list [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    examples: ['orca loop list', 'orca loop list --worktree current --json']
  },
  {
    path: ['loop', 'show'],
    summary: 'Show a loop, its pause reason, and recent iterations',
    usage: 'orca loop show <loopId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'loop-id'],
    positionalArgs: ['loop-id'],
    examples: ['orca loop show loop_01J000000000000000000000']
  },
  {
    path: ['loop', 'pause'],
    summary: 'Pause a loop after the current iteration',
    usage: 'orca loop pause <loopId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'loop-id'],
    positionalArgs: ['loop-id'],
    examples: ['orca loop pause loop_01J000000000000000000000']
  },
  {
    path: ['loop', 'resume'],
    summary: 'Resume a paused loop, optionally granting more iterations',
    usage: 'orca loop resume <loopId> [--add-iterations <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'loop-id', 'add-iterations'],
    positionalArgs: ['loop-id'],
    notes: [
      '--add-iterations raises the iteration cap by n so a loop paused at its cap can continue.'
    ],
    examples: ['orca loop resume loop_01J000000000000000000000 --add-iterations 5']
  },
  {
    path: ['loop', 'stop'],
    summary: 'Stop a loop after the current iteration, or immediately with --now',
    usage: 'orca loop stop <loopId> [--now] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'loop-id', 'now'],
    positionalArgs: ['loop-id'],
    destructive: true,
    notes: ['A stopped loop cannot be resumed. --now aborts the iteration in flight.'],
    examples: [
      'orca loop stop loop_01J000000000000000000000',
      'orca loop stop loop_01J000000000000000000000 --now'
    ]
  },
  {
    path: ['loop', 'steer'],
    summary: 'Add a note to the next iteration prompt',
    usage: 'orca loop steer <loopId> <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'loop-id', 'text'],
    positionalArgs: ['loop-id', 'text'],
    examples: ['orca loop steer loop_01J000000000000000000000 "Focus on the parser first"']
  },
  {
    path: ['loop', 'edit'],
    summary: 'Change a loop prompt, done signal, caps, or options',
    usage:
      'orca loop edit <loopId> [--name <name>] [--prompt <text>] [--repeat-queue] [--every <minutes>] [--anchor from-end|wall-clock] [--session fresh|continue] [--check <command>] [--check-timeout <seconds>] [--check-when every-iteration|on-claim] [--evaluator <condition>] [--max-iterations <n>] [--max-minutes <n>] [--max-cost <usd>] [--no-progress] [--protected-path <glob>]... [--checkpoint-commits] [--ask-before-next] [--resume-at-reset] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'loop-id', ...EDIT_FLAGS],
    positionalArgs: ['loop-id'],
    repeatableFlags: ['protected-path'],
    notes: [
      'Only the flags you pass change; everything else keeps its current value. Changes apply from the next iteration.',
      'Put the loop id before any boolean flag so the id is not read as the flag value.'
    ],
    examples: [
      'orca loop edit loop_01J000000000000000000000 --max-iterations 20 --check "pnpm test"'
    ]
  }
]
