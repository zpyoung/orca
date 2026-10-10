import {
  Bot,
  GitMerge,
  GitPullRequest,
  Hand,
  ListChecks,
  Network,
  PlaneLanding,
  Repeat,
  Shapes,
  Split,
  SquareTerminal,
  Target,
  type LucideIcon
} from 'lucide-react'
import type { NodeType } from '../../../../shared/fork-heimdall-pipeline/document-schema'

/** One icon per node type, so type reads from the icon and label while status alone colors a card. */
export const PIPELINE_NODE_TYPE_ICONS: Record<NodeType | 'unknown', LucideIcon> = {
  agent: Bot,
  check: ListChecks,
  script: SquareTerminal,
  decision: Split,
  loop: Repeat,
  swarm: Network,
  merge: GitMerge,
  gate: Hand,
  land: PlaneLanding,
  objective: Target,
  'pr-sitter': GitPullRequest,
  unknown: Shapes
}
