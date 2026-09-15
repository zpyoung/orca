import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const REVIEW_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['review', 'run-create'],
    summary: 'Create an adversarial review run',
    usage: 'orca review run-create [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['review', 'resolve'],
    summary: 'Capture and classify the review target',
    usage:
      'orca review resolve --target <target> --profile <profile> --run <run_id> [--criteria-file <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target', 'profile', 'run', 'criteria-file']
  },
  {
    path: ['review', 'prepass'],
    summary: 'Run deterministic checks for a review',
    usage: 'orca review prepass --run <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run']
  },
  {
    path: ['review', 'select-model'],
    summary: 'Select an independent reviewer model',
    usage:
      'orca review select-model --run <run_id> --author-family <family> [--reviewer <agent>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'author-family', 'reviewer']
  },
  {
    path: ['review', 'stage-prompt'],
    summary: 'Compose the prompt for a review stage',
    usage: 'orca review stage-prompt --run <run_id> --stage <stage> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'stage']
  },
  {
    path: ['review', 'claims'],
    summary: 'Assign IDs to promoted review findings',
    usage: 'orca review claims --run <run_id> --findings <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'findings']
  },
  {
    path: ['review', 'merge'],
    summary: 'Merge review-stage judgments into findings',
    usage:
      'orca review merge --run <run_id> --findings <path> --judgments <path> --stage <stage> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'findings', 'judgments', 'stage']
  },
  {
    path: ['review', 'gate'],
    summary: 'Compute the evidence-gated review verdict',
    usage: 'orca review gate --run <run_id> --depth <depth> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'depth']
  },
  {
    path: ['review', 'manifest'],
    summary: 'Assemble the completed review manifest',
    usage: 'orca review manifest --run <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run']
  },
  {
    path: ['review', 'run-abort'],
    summary: 'Abort an adversarial review run',
    usage: 'orca review run-abort --run <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run'],
    destructive: true
  },
  {
    path: ['review', 'run-list'],
    summary: 'List adversarial review runs',
    usage: 'orca review run-list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['review', 'run-show'],
    summary: 'Show an adversarial review run',
    usage: 'orca review run-show --run <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run']
  },
  {
    path: ['review', 'run-fail'],
    summary: 'Mark an adversarial review run as failed',
    usage: 'orca review run-fail --run <run_id> [--reason <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'reason'],
    destructive: true
  },
  {
    path: ['review', 'dismiss'],
    summary: 'Dismiss a review finding with a reason',
    usage: 'orca review dismiss --run <run_id> --finding <finding_id> --reason <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'finding', 'reason'],
    destructive: true
  }
]
