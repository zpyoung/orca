import type { ZodError, ZodIssue } from 'zod'
import type {
  KernelAction,
  OwnerAdapter,
  OwnerInterventionRejection
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import {
  KindAgnosticInterventionSchema,
  type Intervention,
  type KindAgnosticIntervention
} from '../../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { OwnerReportReadResult } from './owner-report-io'

export type OwnerInterventionOutcome<TAction extends KernelAction> =
  | { status: 'agnostic'; move: KindAgnosticIntervention }
  | { status: 'applied'; action: TAction }
  | {
      status: 'rejected'
      gate: OwnerInterventionRejection['gate']
      reason: string
    }
  | { status: 'malformed'; reason: string }

const AGNOSTIC_KINDS: ReadonlySet<string> = new Set(
  KindAgnosticInterventionSchema.options.map((option) => option.shape.kind.value)
)

function isAgnostic(intervention: Intervention): intervention is KindAgnosticIntervention {
  return AGNOSTIC_KINDS.has(intervention.kind)
}

function isIndexable(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function valueAtPath(source: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    return isIndexable(current) ? current[segment] : undefined
  }, source)
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join('.') : 'intervention'
}

function isTooBigIssue(issue: ZodIssue): issue is Extract<ZodIssue, { code: 'too_big' }> {
  return issue.code === 'too_big'
}

/**
 * A too-long field's raw Zod error names only the schema limit, never the owner's own text, so
 * the park reason otherwise discards a full turn of reasoning behind an opaque validator dump.
 * This adds a bounded diagnostic preview while stating that the semantic submission stayed
 * rejected rather than being silently corrected.
 */
function describeInterventionValidationFailure(error: ZodError, report: unknown): string {
  const tooBig = error.issues.find(isTooBigIssue)
  if (tooBig && tooBig.origin === 'string' && typeof tooBig.maximum === 'number') {
    const field = formatIssuePath(tooBig.path)
    const limit = tooBig.maximum
    const value = valueAtPath(report, tooBig.path)
    return typeof value === 'string'
      ? `${field} is ${value.length} JavaScript UTF-16 code units, over the ${limit}-code-unit limit; previewed the first ${limit} code units (submission rejected, no correction applied): ${value.slice(0, limit)}`
      : `${field} exceeds the ${limit}-code-unit JavaScript UTF-16 limit.`
  }
  const [first, ...rest] = error.issues
  if (!first) {
    return error.message.slice(0, 2_048)
  }
  const suffix =
    rest.length > 0 ? ` (+${rest.length} more issue${rest.length === 1 ? '' : 's'})` : ''
  return `${formatIssuePath(first.path)}: ${first.message}${suffix}`
}

/**
 * Parses the owner's report, applies gates 1 (write territory), 2 (landing bar) and 4
 * (`sitterOverrides`) for a kind-specific move, and returns the adapter action with its native
 * capability intact. The caller enforces that native capability before stamping and enforcing the
 * owner-intervention capability, so owner authority cannot bypass a disabled kind capability.
 */
export function evaluateOwnerIntervention<TWorld, TAction extends KernelAction>(args: {
  read: OwnerReportReadResult<unknown>
  owner: OwnerAdapter<TWorld, TAction>
  snapshot: Snapshot<TWorld>
  ledger: WatcherLedger
  enrollment: WatcherEnrollment
  /** The deviation this reply answers; a message-worker move must target its stalled dispatch. */
  deviation?: Deviation
}): OwnerInterventionOutcome<TAction> {
  if (!args.read.ok) {
    return {
      status: 'malformed',
      reason: `${args.read.reason}${args.read.detail ? `: ${args.read.detail}` : ''}`
    }
  }
  const parsed = args.owner.interventionSchema.safeParse(args.read.report)
  if (!parsed.success) {
    return {
      status: 'malformed',
      reason: describeInterventionValidationFailure(parsed.error, args.read.report)
    }
  }
  const intervention = parsed.data
  if (isAgnostic(intervention)) {
    const deviation = args.deviation
    if (
      intervention.kind === 'message-worker' &&
      (deviation?.kind !== 'stall' || deviation.dispatchId !== intervention.dispatchId)
    ) {
      return {
        status: 'malformed',
        reason: `message-worker dispatchId ${intervention.dispatchId} does not match the open stall deviation; message-worker only answers a stalled worker.`
      }
    }
    return { status: 'agnostic', move: intervention }
  }
  const rejection = args.owner.rejectIntervention(
    intervention,
    args.snapshot,
    args.ledger,
    args.enrollment
  )
  if (rejection) {
    return { status: 'rejected', gate: rejection.gate, reason: rejection.reason }
  }
  return {
    status: 'applied',
    action: args.owner.actionForIntervention(intervention, args.snapshot, args.ledger)
  }
}
