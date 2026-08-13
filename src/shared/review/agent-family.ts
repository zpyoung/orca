import { TUI_AGENT_AUTO_PICK_ORDER } from '../tui-agent-selection'
import type { TuiAgent } from '../types'

export const AGENT_FAMILIES = ['anthropic', 'openai', 'google', 'other'] as const
export type AgentFamily = (typeof AGENT_FAMILIES)[number]

/**
 * The model family each Orca agent CLI dispatches to, for independence
 * checks between an artifact's author and its reviewer. `other` is the
 * correct answer — not a gap — for any agent that is multi-model,
 * third-party, or backed by a provider outside the three this port
 * distinguishes: it matches no candidate's family, so every ladder rung is
 * fully independent of it (mirrors the upstream script's own `other`
 * convention for an author family the ladder does not dispatch to). Only
 * the officially first-party CLIs for each of the three named vendors get a
 * specific family. `satisfies` makes a future `TuiAgent` addition a compile
 * error here rather than a silent `other`.
 */
export const TUI_AGENT_FAMILY = {
  claude: 'anthropic',
  'claude-agent-teams': 'anthropic',
  openclaude: 'other',
  codex: 'openai',
  autohand: 'other',
  opencode: 'other',
  'mimo-code': 'other',
  pi: 'other',
  omp: 'other',
  gemini: 'google',
  antigravity: 'google',
  aider: 'other',
  goose: 'other',
  amp: 'other',
  kilo: 'other',
  kiro: 'other',
  crush: 'other',
  aug: 'other',
  cline: 'other',
  codebuff: 'other',
  'command-code': 'other',
  continue: 'other',
  cursor: 'other',
  droid: 'other',
  kimi: 'other',
  'mistral-vibe': 'other',
  'qwen-code': 'other',
  rovo: 'other',
  hermes: 'other',
  openclaw: 'other',
  copilot: 'other',
  grok: 'other',
  devin: 'other',
  ante: 'other',
  trae: 'other'
} as const satisfies Record<TuiAgent, AgentFamily>

export function getAgentFamily(agent: TuiAgent): AgentFamily {
  return TUI_AGENT_FAMILY[agent]
}

/**
 * Independence is structural: an agent favors its own output, so reviewer
 * candidates are ordered cross-family first and the author's own family last
 * resort — upstream's ladder-ordering rule, applied over Orca's catalog and
 * its detected+enabled auto-pick order within each group.
 */
export function orderReviewerCandidates(
  authorFamily: AgentFamily,
  candidates: Iterable<TuiAgent>
): TuiAgent[] {
  const available = new Set(candidates)
  const ordered = TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => available.has(agent))
  const crossFamily = ordered.filter((agent) => getAgentFamily(agent) !== authorFamily)
  const sameFamily = ordered.filter((agent) => getAgentFamily(agent) === authorFamily)
  return [...crossFamily, ...sameFamily]
}
