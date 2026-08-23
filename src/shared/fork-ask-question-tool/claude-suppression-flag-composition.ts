import {
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
} from './claude-suppression-flags'
import { quoteStartupArg, tokenizeStartupCommand, type AgentStartupShell } from '../tui-agent-startup-shell'
import type { TuiAgent } from '../tui-agent'

type SuppressionPair = {
  flag: string
  value: string
  aliases: readonly string[]
}

const SUPPRESSION_PAIRS: readonly SuppressionPair[] = [
  {
    flag: CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
    value: CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
    aliases: ['--disallowedTools', '--disallowed-tools']
  },
  {
    flag: CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
    value: CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE,
    aliases: ['--append-system-prompt', '--append-system-prompt-file']
  }
]

function tokensOf(text: string, shell: AgentStartupShell): readonly string[] {
  const tokenized = tokenizeStartupCommand(text, shell)
  return tokenized.ok ? tokenized.tokens : []
}

function pairsMissingFrom(scanText: string, shell: AgentStartupShell): readonly SuppressionPair[] {
  const tokens = new Set(tokensOf(scanText, shell))
  return SUPPRESSION_PAIRS.filter((pair) => !pair.aliases.some((alias) => tokens.has(alias)))
}

function quotedPair(pair: SuppressionPair, shell: AgentStartupShell): string {
  return `${quoteStartupArg(pair.flag, shell)} ${quoteStartupArg(pair.value, shell)}`
}

function appendPairs(
  command: string,
  pairs: readonly SuppressionPair[],
  shell: AgentStartupShell
): string {
  if (pairs.length === 0) {
    return command
  }
  return `${command} ${pairs.map((pair) => quotedPair(pair, shell)).join(' ')}`
}

export type ClaudeLaunchCommandFlagsInput = {
  agent: TuiAgent
  shell: AgentStartupShell
  /** The user's raw `agentCmdOverrides` string for this agent, if any — scanned
   *  in place of the resolved command per the per-flag-skip contract. */
  override?: string | null
  command: string
  commandWithoutSessionOptions: string
  claudeSuppressionFlags?: string[] | null
}

/**
 * Appends Orca's AskUserQuestion suppression flags to a Claude launch command.
 * Skips a flag already present in the effective command (the user's override,
 * else the resolved command) rather than duplicating or rewriting it, and is a
 * no-op for any agent but `claude` or when no flags are supplied — preserving
 * today's output byte-for-byte in both cases.
 */
export function appendClaudeSuppressionFlags(
  args: ClaudeLaunchCommandFlagsInput
): { command: string; commandWithoutSessionOptions: string } {
  const identity = { command: args.command, commandWithoutSessionOptions: args.commandWithoutSessionOptions }
  if (args.agent !== 'claude' || !args.claudeSuppressionFlags?.length) {
    return identity
  }
  const pairs = pairsMissingFrom(args.override || args.command, args.shell)
  return {
    command: appendPairs(args.command, pairs, args.shell),
    commandWithoutSessionOptions: appendPairs(args.commandWithoutSessionOptions, pairs, args.shell)
  }
}

/**
 * Reconciles a resumed session's captured launch command against a freshly
 * re-evaluated gate verdict. A non-null verdict injects any suppression pair
 * the capture is missing (per-flag skip prevents duplicating one already
 * baked in from the original launch); a null verdict strips exactly the
 * token pairs Orca itself injected, matched against its own literal flag and
 * value — a user-authored flag, even one with the same name, is left alone
 * unless its value is byte-identical to Orca's, so this can only remove what
 * Orca put there.
 */
export function applyClaudeSuppressionFlagsToResumeCommand(args: {
  agent: TuiAgent
  shell: AgentStartupShell
  command: string
  claudeSuppressionFlags?: string[] | null
}): string {
  if (args.agent !== 'claude') {
    return args.command
  }
  if (args.claudeSuppressionFlags?.length) {
    return appendPairs(args.command, pairsMissingFrom(args.command, args.shell), args.shell)
  }
  return SUPPRESSION_PAIRS.reduce(
    (command, pair) => command.replace(` ${quotedPair(pair, args.shell)}`, ''),
    args.command
  )
}
