import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  OwnerStateBrief,
  OwnerStateBriefContext
} from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { searchMinimalOmissionPrefix } from '../fork-heimdall/judgment/omission-budget-search'
import { activeObjectiveRevision } from '../../shared/fork-heimdall-objective/decision-context'
import type {
  ObjectiveNodeState,
  ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'

const OBJECTIVE_TEXT_MAX_CODE_UNITS = 4_000

type OwnerStateNode = {
  taskKey: string
  state: ObjectiveNodeState
  dispatchId: string | null
  failingCriteria: string[]
}

type OwnerStateOmissions = {
  objectiveText?: {
    omittedCodeUnits: number
    reference: 'snapshot.world.contract.objectiveText'
  }
  nodes?: {
    count: number
    reference: 'snapshot.world.plan.nodes'
  }
}

type OwnerState = {
  objectiveText: string
  tier: string
  landingBar: string
  writeTerritory: readonly string[]
  activeRevision: { id: string; number: number; digest: string } | null
  nodes: OwnerStateNode[]
  omissions?: OwnerStateOmissions
}

/** Nodes least useful to a stuck decision are ordered first, so the byte-budget search drops them first. */
function nodeDropPriority(state: ObjectiveNodeState): number {
  switch (state) {
    case 'succeeded':
    case 'replanned':
      return 0
    case 'pending':
    case 'awaiting-approval':
    case 'blocked-by-deps':
      return 1
    case 'dispatched':
      return 2
    case 'failed':
      return 3
  }
}

function boundedObjectiveText(value: string): {
  text: string
  omission: OwnerStateOmissions['objectiveText']
} {
  if (value.length <= OBJECTIVE_TEXT_MAX_CODE_UNITS) {
    return { text: value, omission: undefined }
  }
  const includedCodeUnits = OBJECTIVE_TEXT_MAX_CODE_UNITS - 1
  return {
    text: `${value.slice(0, includedCodeUnits)}…`,
    omission: {
      omittedCodeUnits: value.length - includedCodeUnits,
      reference: 'snapshot.world.contract.objectiveText'
    }
  }
}

function isMandatoryNode(
  node: OwnerStateNode,
  context: OwnerStateBriefContext | undefined
): boolean {
  const deviation = context?.deviation
  const taskKey =
    deviation && 'taskKey' in deviation && typeof deviation.taskKey === 'string'
      ? deviation.taskKey
      : null
  const dispatchId =
    deviation && 'dispatchId' in deviation && typeof deviation.dispatchId === 'string'
      ? deviation.dispatchId
      : null
  return (
    (node.state !== 'succeeded' && node.state !== 'replanned') ||
    (taskKey !== null && node.taskKey === taskKey) ||
    (dispatchId !== null && node.dispatchId === dispatchId)
  )
}

function project(state: OwnerState, maxBytes: number): { text: string; fitsStateBudget: boolean } {
  const text = JSON.stringify(state)
  return { text, fitsStateBudget: Buffer.byteLength(text, 'utf8') <= maxBytes }
}

/**
 * The objective kind's contribution to the owner's brief. Every current nonterminal and triggering
 * node is mandatory; only completed node summaries may be omitted, and every display-only omission
 * points back to the canonical snapshot field.
 */
export function describeObjectiveOwnerState(
  snapshot: Snapshot<ObjectiveWorld>,
  _ledger: WatcherLedger,
  maxBytes: number,
  context?: OwnerStateBriefContext
): OwnerStateBrief {
  const world = snapshot.world
  const revision = activeObjectiveRevision(world)
  const nodes = revision ? world.plan.nodes.filter((node) => node.revisionId === revision.id) : []
  const summaries: OwnerStateNode[] = nodes.map((node) => ({
    taskKey: node.taskKey,
    state: node.state,
    dispatchId: node.dispatchId,
    failingCriteria: node.criteria
      .filter(
        (criterion) =>
          criterion.lastCheck &&
          (criterion.lastCheck.exitCode !== 0 || criterion.lastCheck.timedOut)
      )
      .map((criterion) => criterion.id)
  }))
  const optional = summaries
    .filter((node) => !isMandatoryNode(node, context))
    .sort((left, right) => {
      const priority = nodeDropPriority(left.state) - nodeDropPriority(right.state)
      return priority || (left.taskKey < right.taskKey ? -1 : left.taskKey > right.taskKey ? 1 : 0)
    })
  const objective = boundedObjectiveText(world.contract.objectiveText)
  const build = (dropCount: number): OwnerState => {
    const omitted = new Set(optional.slice(0, dropCount))
    const omissions: OwnerStateOmissions = {
      ...(objective.omission ? { objectiveText: objective.omission } : {}),
      ...(dropCount > 0
        ? {
            nodes: {
              count: dropCount,
              reference: 'snapshot.world.plan.nodes' as const
            }
          }
        : {})
    }
    return {
      objectiveText: objective.text,
      tier: world.contract.tier,
      landingBar: world.contract.landingBar,
      writeTerritory: world.contract.writeTerritory,
      activeRevision: revision
        ? { id: revision.id, number: revision.number, digest: revision.digest }
        : null,
      nodes: summaries.filter((node) => !omitted.has(node)),
      ...(Object.keys(omissions).length > 0 ? { omissions } : {})
    }
  }

  const base = project(build(0), maxBytes)
  if (base.fitsStateBudget || optional.length === 0) {
    return { text: base.text, truncated: objective.omission !== undefined }
  }
  const found = searchMinimalOmissionPrefix(optional.length, (prefix) =>
    project(build(prefix), maxBytes)
  )
  const result = found?.result ?? base
  return {
    text: result.text,
    truncated: objective.omission !== undefined || (found?.prefix ?? 0) > 0
  }
}
