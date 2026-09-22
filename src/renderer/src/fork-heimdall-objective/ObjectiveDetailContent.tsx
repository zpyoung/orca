import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findIndexedFolderWorkspaceOwner } from '@/lib/worktree-runtime-owner-index'
import { HEIMDALL_PARALLEL_EXECUTION_UNSUPPORTED_NOTE } from '../../../shared/fork-heimdall/capability'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import { OBJECTIVE_LANDING_LADDER } from '../../../shared/fork-heimdall-objective/landing-ladder'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { formatHeimdallTime } from '../fork-heimdall/fleet-format'
import { sameWatcherTarget } from '../fork-heimdall/fleet-selectors'
import {
  OBJECTIVE_CAPABILITIES,
  OBJECTIVE_ROLES,
  OBJECTIVE_SITTER_CAPABILITIES
} from './objective-enrollment-model'
import { objectiveHandoffEvidence } from './handoff-evidence'
import { shortObjectiveIdentity } from './objective-detail-format'
import {
  objectiveCapabilityLabel,
  objectiveCapabilityModeLabel,
  objectiveLandingBarLabel,
  objectiveRoleLabel,
  objectiveSitterCapabilityLabel,
  objectiveTierLabel,
  objectiveTrainStateLabel,
  objectiveWorkspaceKindLabel
} from './objective-copy'
import { ObjectivePlan } from './ObjectivePlan'

function ContractValue({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-b border-border/60 py-2 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground">{children}</dd>
    </div>
  )
}

function ObjectiveContract({
  detail,
  row
}: {
  detail: ObjectiveDetail
  row: WatcherFleetEntry
}): React.JSX.Element {
  const contract = detail.contract
  const enrollment = row.entry.enrollment
  const folderScope = parseWorkspaceKey(enrollment.worktreeId ?? '')
  const folderWorkspaceName = useAppStore((state) => {
    if (contract.workspaceKind !== 'folder' || folderScope?.type !== 'folder') {
      return null
    }
    const owner = findIndexedFolderWorkspaceOwner(
      state.folderWorkspaces,
      folderScope.folderWorkspaceId,
      enrollment.executionHostId
    )
    return state.folderWorkspaces.find((workspace) => workspace === owner)?.name ?? null
  })
  const roleAgents = OBJECTIVE_ROLES.flatMap((role) => {
    const agent = contract.roleAgents[role]
    return agent ? [{ role, agent }] : []
  })
  const sitterOverrides = OBJECTIVE_SITTER_CAPABILITIES.flatMap((capability) => {
    const mode = contract.sitterOverrides[capability]
    return mode ? [{ capability, mode }] : []
  })
  return (
    <section aria-labelledby="objective-contract-title">
      <h3
        id="objective-contract-title"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
      >
        {translate('fork.heimdallObjective.detail.contract', 'Contract')}
      </h3>
      <div className="rounded-md border border-border bg-muted/10 px-3">
        <ContractValue label={translate('fork.heimdallObjective.detail.objective', 'Objective')}>
          <span className="whitespace-pre-wrap">{contract.objectiveText}</span>
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.watcherId', 'Watcher ID')}>
          <span className="select-text font-mono [overflow-wrap:anywhere]">
            {row.target.watcherId}
          </span>
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.tier', 'Tier')}>
          {objectiveTierLabel(contract.tier)}
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.landingBar', 'Landing bar')}>
          {objectiveLandingBarLabel(contract.landingBar)}
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.workspace', 'Workspace')}>
          {contract.workspaceKind === 'git' && enrollment.worktreeId
            ? translate(
                'fork.heimdallObjective.detail.workspaceGitValue',
                '{{kind}} · {{repo}} / {{worktree}}',
                {
                  kind: objectiveWorkspaceKindLabel(contract.workspaceKind),
                  repo: enrollment.repoId,
                  worktree: enrollment.worktreeId
                }
              )
            : translate(
                'fork.heimdallObjective.detail.workspaceFolderValue',
                '{{kind}} · {{repo}}',
                {
                  kind: objectiveWorkspaceKindLabel(contract.workspaceKind),
                  repo: folderWorkspaceName ?? enrollment.repoId
                }
              )}
        </ContractValue>
        <ContractValue
          label={translate('fork.heimdallObjective.detail.maxConcurrency', 'Concurrency')}
        >
          {contract.maxConcurrency}
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.lanes', 'Lanes')}>
          {contract.lanesEnabled !== false &&
          !row.capabilityNotes.includes(HEIMDALL_PARALLEL_EXECUTION_UNSUPPORTED_NOTE)
            ? translate('fork.heimdallObjective.detail.enabled', 'Enabled')
            : translate('fork.heimdallObjective.detail.disabled', 'Disabled')}
        </ContractValue>
        <ContractValue
          label={translate('fork.heimdallObjective.detail.territory', 'Write territory')}
        >
          <ul className="space-y-1 font-mono">
            {contract.writeTerritory.map((glob) => (
              <li key={glob}>{glob}</li>
            ))}
          </ul>
        </ContractValue>
        <ContractValue
          label={translate('fork.heimdallObjective.detail.capabilities', 'Capabilities')}
        >
          <span>
            {OBJECTIVE_CAPABILITIES.map(
              (capability) =>
                `${objectiveCapabilityLabel(capability)}: ${objectiveCapabilityModeLabel(
                  row.entry.enrollment.capabilities[capability] ?? 'off'
                )}`
            ).join(' · ')}
          </span>
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.budget', 'Budget')}>
          {translate(
            'fork.heimdallObjective.detail.budgetValue',
            '{{hours}} active hours · {{turns}} turns',
            {
              hours:
                row.entry.enrollment.budget.wallClockActiveMs === null
                  ? '∞'
                  : row.entry.enrollment.budget.wallClockActiveMs / 3_600_000,
              turns: row.entry.enrollment.budget.turns ?? '∞'
            }
          )}
        </ContractValue>
        <ContractValue label={translate('fork.heimdallObjective.detail.roleAgents', 'Role agents')}>
          {roleAgents.length > 0
            ? roleAgents
                .map(({ role, agent }) => `${objectiveRoleLabel(role)}: ${agent}`)
                .join(' · ')
            : translate('fork.heimdallObjective.detail.automatic', 'Automatic')}
        </ContractValue>
        <ContractValue
          label={translate('fork.heimdallObjective.detail.sitterOverrides', 'Landing overrides')}
        >
          {sitterOverrides.length > 0
            ? sitterOverrides
                .map(
                  ({ capability, mode }) =>
                    `${objectiveSitterCapabilityLabel(capability)}: ${objectiveCapabilityModeLabel(mode)}`
                )
                .join(' · ')
            : translate('fork.heimdallObjective.detail.defaults', 'Landing defaults')}
        </ContractValue>
      </div>
    </section>
  )
}

function ObjectiveParallelExecution({
  parallel
}: {
  parallel: NonNullable<ObjectiveDetail['parallel']>
}): React.JSX.Element {
  return (
    <section aria-labelledby="objective-parallel-title">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id="objective-parallel-title"
          className="text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
        >
          {translate('fork.heimdallObjective.detail.parallelExecution', 'Parallel execution')}
        </h3>
        <span className="text-xs font-medium tabular-nums">
          {translate(
            'fork.heimdallObjective.detail.runningAgainstCap',
            '{{running}} of {{cap}} running',
            {
              running: parallel.runningCount,
              cap: parallel.effectiveMaxConcurrency
            }
          )}
        </span>
      </div>
      {parallel.note ? (
        <p
          className="mb-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
          role="status"
        >
          {parallel.note}
        </p>
      ) : null}
      {parallel.dispatches.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/10 px-3 py-4 text-xs text-muted-foreground">
          {translate(
            'fork.heimdallObjective.detail.noParallelDispatches',
            'No isolated dispatches yet.'
          )}
        </p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border bg-muted/10">
          {parallel.dispatches.map((dispatch) => {
            const lane = dispatch.laneTaskKeys.length > 1
            return (
              <li
                key={dispatch.attemptFingerprint}
                className="flex flex-wrap items-start gap-2 px-3 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">
                    {lane
                      ? translate('fork.heimdallObjective.detail.lane', 'Lane')
                      : translate('fork.heimdallObjective.detail.node', 'Node')}
                  </p>
                  <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">
                    {dispatch.laneTaskKeys.join(' → ')}
                  </p>
                  {dispatch.conflictPaths.length > 0 ? (
                    <p className="mt-1 break-words text-[11px] text-status-warning-foreground">
                      {translate(
                        'fork.heimdallObjective.detail.conflicts',
                        'Conflicts: {{paths}}',
                        { paths: dispatch.conflictPaths.join(', ') }
                      )}
                    </p>
                  ) : null}
                </div>
                <Badge variant={dispatch.state === 'applied' ? 'secondary' : 'outline'}>
                  {objectiveTrainStateLabel(dispatch.state)}
                </Badge>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

const EMPTY_FLEET: readonly WatcherFleetEntry[] = []
function latestLandingEvidence(
  detail: ObjectiveDetail,
  rung: ObjectiveDetail['landing'][number]['rung']
): ObjectiveDetail['landing'][number] | undefined {
  for (let index = detail.landing.length - 1; index >= 0; index -= 1) {
    const evidence = detail.landing[index]
    if (evidence?.rung === rung) {
      return evidence
    }
  }
  return undefined
}

function ObjectiveLanding({
  detail,
  ledger,
  row
}: {
  detail: ObjectiveDetail
  ledger: WatcherLedger | null
  row: WatcherFleetEntry
}): React.JSX.Element {
  const fleet = useAppStore((state) => state.heimdallFleet?.entries ?? EMPTY_FLEET)
  const selectWatcher = useAppStore((state) => state.selectHeimdallWatcher)
  const handoff = objectiveHandoffEvidence(ledger)
  const sitterTarget = handoff ? { ...row.target, watcherId: handoff.sitterWatcherId } : null
  const sitter = sitterTarget
    ? fleet.find((candidate) => sameWatcherTarget(sitterTarget, candidate.target))
    : undefined
  const sitterMerged =
    sitter?.entry.status.state === 'terminal' && sitter.entry.status.reason === 'review merged'
  const sitterLive =
    sitter !== undefined &&
    sitter.entry.enrollment.terminalAtMs === null &&
    sitter.entry.status.enabled &&
    sitter.entry.status.state !== 'terminal' &&
    sitter.entry.status.state !== 'disabled'
  const targetIndex = OBJECTIVE_LANDING_LADDER.indexOf(detail.contract.landingBar)
  const visibleRungs = OBJECTIVE_LANDING_LADDER.slice(0, targetIndex + 1)

  return (
    <section aria-labelledby="objective-landing-title">
      <h3
        id="objective-landing-title"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
      >
        {translate('fork.heimdallObjective.detail.landing', 'Landing')}
      </h3>
      <ol className="divide-y divide-border rounded-md border border-border bg-muted/10">
        {visibleRungs.map((rung, index) => {
          const evidence = rung === 'merged' ? undefined : latestLandingEvidence(detail, rung)
          const merged = rung === 'merged' && sitterMerged
          const watchedBySitter = rung === 'merged' && sitterLive
          const reached = Boolean(evidence) || merged
          return (
            <li
              key={rung}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
              data-objective-landing-reached={reached ? '' : undefined}
            >
              <span className={reached ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                {objectiveLandingBarLabel(rung)}
              </span>
              {index === targetIndex ? (
                <Badge variant="outline">
                  {translate('fork.heimdallObjective.detail.target', 'Target')}
                </Badge>
              ) : null}
              {evidence ? (
                <>
                  <Badge variant="secondary">
                    {translate('fork.heimdallObjective.detail.reached', 'Reached')}
                  </Badge>
                  {rung === 'hosted-review' && handoff ? (
                    <>
                      <Badge variant="outline">
                        {translate('fork.heimdallObjective.detail.handedOff', 'Handed off')}
                      </Badge>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto gap-1 p-0 text-xs"
                        onClick={() => void window.api.shell.openUrl(handoff.reviewUrl)}
                      >
                        {translate('fork.heimdallObjective.detail.openReview', 'Open review')}
                        <ExternalLink className="size-3" aria-hidden />
                      </Button>
                    </>
                  ) : null}
                  <span
                    className="font-mono text-[11px] text-muted-foreground"
                    title={evidence.contentIdentity}
                  >
                    {shortObjectiveIdentity(evidence.contentIdentity)}
                  </span>
                  <time
                    className="ml-auto text-[11px] text-muted-foreground"
                    dateTime={new Date(evidence.atMs).toISOString()}
                  >
                    {formatHeimdallTime(evidence.atMs)}
                  </time>
                </>
              ) : merged ? (
                <Badge variant="secondary">
                  {translate('fork.heimdallObjective.detail.merged', 'Merged')}
                </Badge>
              ) : watchedBySitter && sitter ? (
                <>
                  <span className="text-[11px] text-muted-foreground">
                    {translate(
                      'fork.heimdallObjective.detail.watchedBySitter',
                      'Watched by sitter'
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 font-mono text-[11px]"
                    onClick={() => selectWatcher(sitter.target)}
                  >
                    {sitter.target.watcherId}
                  </Button>
                </>
              ) : (
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {translate('fork.heimdallObjective.detail.pending', 'Pending')}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {translate(
          'fork.heimdallObjective.detail.landingHelp',
          'Rungs above the reached one are pending; the run stops at its bar.'
        )}
      </p>
    </section>
  )
}

export function ObjectiveDetailContent({
  detail,
  ledger,
  row
}: {
  detail: ObjectiveDetail
  ledger: WatcherLedger | null
  row: WatcherFleetEntry
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      {detail.parallel ? <ObjectiveParallelExecution parallel={detail.parallel} /> : null}
      <ObjectiveContract detail={detail} row={row} />
      <ObjectivePlan detail={detail} />
      <ObjectiveLanding detail={detail} ledger={ledger} row={row} />
    </div>
  )
}
