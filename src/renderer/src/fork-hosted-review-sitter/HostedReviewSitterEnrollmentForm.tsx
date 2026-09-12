import React, { useId } from 'react'
import { Bot, Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type {
  HostedReviewBranchUpdateMode,
  HostedReviewMergeMethod,
  HostedReviewSitterCapabilities,
  HostedReviewSitterCapability,
  HostedReviewSitterCapabilityMode,
  HostedReviewSitterProvider
} from '../../../shared/fork-hosted-review-sitter/types'
import {
  hostedReviewSitterCapabilityLabel,
  hostedReviewSitterCapabilityModeLabel
} from './hosted-review-sitter-format'

const CAPABILITIES: readonly HostedReviewSitterCapability[] = [
  'updateBranch',
  'resolveConflicts',
  'fixChecks',
  'merge'
]
const CAPABILITY_MODES: readonly HostedReviewSitterCapabilityMode[] = ['off', 'gated', 'on']

function CapabilityControl({
  capability,
  value,
  disabled,
  onChange
}: {
  capability: HostedReviewSitterCapability
  value: HostedReviewSitterCapabilityMode
  disabled: boolean
  onChange: (value: HostedReviewSitterCapabilityMode) => void
}): React.JSX.Element {
  const capabilityLabelId = useId()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_104px] items-center gap-2">
      <label id={capabilityLabelId} className="truncate text-[11px] text-foreground">
        {hostedReviewSitterCapabilityLabel(capability)}
      </label>
      <Select
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as HostedReviewSitterCapabilityMode)}
        disabled={disabled}
      >
        <SelectTrigger
          aria-labelledby={capabilityLabelId}
          size="sm"
          className="h-7 w-full text-[11px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CAPABILITY_MODES.map((mode) => (
            <SelectItem key={mode} value={mode} className="text-xs">
              {hostedReviewSitterCapabilityModeLabel(mode)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export type HostedReviewSitterEnrollmentFormProps = {
  provider: HostedReviewSitterProvider
  capabilities: HostedReviewSitterCapabilities
  branchUpdateMode: HostedReviewBranchUpdateMode
  mergeMethod: 'default' | HostedReviewMergeMethod
  activeBudgetHours: number
  activeElsewhereCount: number
  blockedReason: string | null
  busy: boolean
  arming: boolean
  rearming: boolean
  onCapabilitiesChange: (capabilities: HostedReviewSitterCapabilities) => void
  onBranchUpdateModeChange: (mode: HostedReviewBranchUpdateMode) => void
  onMergeMethodChange: (method: 'default' | HostedReviewMergeMethod) => void
  onActiveBudgetHoursChange: (hours: number) => void
  onArm: () => void
}

export function HostedReviewSitterEnrollmentForm({
  provider,
  capabilities,
  branchUpdateMode,
  mergeMethod,
  activeBudgetHours,
  activeElsewhereCount,
  blockedReason,
  busy,
  arming,
  rearming,
  onCapabilitiesChange,
  onBranchUpdateModeChange,
  onMergeMethodChange,
  onActiveBudgetHoursChange,
  onArm
}: HostedReviewSitterEnrollmentFormProps): React.JSX.Element {
  const validBudget = Number.isFinite(activeBudgetHours) && activeBudgetHours > 0
  const branchUpdateLabelId = useId()
  const mergeMethodLabelId = useId()
  const budgetInputId = useId()
  const activeElsewhereCopy =
    activeElsewhereCount === 1
      ? translate(
          'fork.hostedReviewSitter.activeElsewhere.one',
          '{{count}} sitter is active on another review.',
          { count: activeElsewhereCount }
        )
      : translate(
          'fork.hostedReviewSitter.activeElsewhere.many',
          '{{count}} sitters are active on other reviews.',
          { count: activeElsewhereCount }
        )
  return (
    <div className="mt-2 space-y-2.5">
      {activeElsewhereCount > 0 ? (
        <div className="space-y-1 text-[10px] leading-relaxed text-muted-foreground">
          <p>{activeElsewhereCopy}</p>
          <p>
            {translate(
              'fork.hostedReviewSitter.stopEffect',
              'Stopping prevents new actions; an in-flight provider operation may finish.'
            )}
          </p>
        </div>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {provider === 'gitlab'
          ? translate(
              'fork.hostedReviewSitter.enrollment.descriptionGitLab',
              'Watch this merge request and choose which actions Orca may take.'
            )
          : translate(
              'fork.hostedReviewSitter.enrollment.descriptionGitHub',
              'Watch this pull request and choose which actions Orca may take.'
            )}
      </p>
      <div className="space-y-1.5">
        {CAPABILITIES.map((capability) => (
          <CapabilityControl
            key={capability}
            capability={capability}
            value={capabilities[capability]}
            disabled={busy}
            onChange={(mode) => onCapabilitiesChange({ ...capabilities, [capability]: mode })}
          />
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {translate(
          'fork.hostedReviewSitter.enrollment.askAuthority',
          'Ask may prepare and commit fixes in this worktree; Orca waits for approval before publishing them. It also waits before triggering CI, updating the branch, or merging.'
        )}
      </p>

      <div className="space-y-1">
        <label id={branchUpdateLabelId} className="text-[10px] font-medium text-muted-foreground">
          {translate('fork.hostedReviewSitter.enrollment.branchUpdate', 'Branch update')}
        </label>
        <Select
          value={branchUpdateMode}
          onValueChange={(value) => onBranchUpdateModeChange(value as HostedReviewBranchUpdateMode)}
          disabled={busy}
        >
          <SelectTrigger
            aria-labelledby={branchUpdateLabelId}
            size="sm"
            className="h-7 w-full text-[11px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge-base-update" className="text-xs">
              {translate(
                'fork.hostedReviewSitter.enrollment.updateMergeBase',
                'Merge base into branch (recommended)'
              )}
            </SelectItem>
            <SelectItem value="rebase" className="text-xs">
              {translate('fork.hostedReviewSitter.enrollment.updateRebase', 'Rebase onto base')}
            </SelectItem>
          </SelectContent>
        </Select>
        {branchUpdateMode === 'rebase' ? (
          <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              {translate(
                'fork.hostedReviewSitter.enrollment.rebaseWarning',
                'Rebasing rewrites commit SHAs, may dismiss approvals, and force-pushes the rewritten branch.'
              )}
            </span>
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label id={mergeMethodLabelId} className="text-[10px] font-medium text-muted-foreground">
          {translate('fork.hostedReviewSitter.enrollment.mergeMethod', 'Merge method')}
        </label>
        <Select
          value={mergeMethod}
          onValueChange={(value) =>
            onMergeMethodChange(value as 'default' | HostedReviewMergeMethod)
          }
          disabled={busy}
        >
          <SelectTrigger
            aria-labelledby={mergeMethodLabelId}
            size="sm"
            className="h-7 w-full text-[11px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default" className="text-xs">
              {translate('fork.hostedReviewSitter.enrollment.mergeDefault', 'Repository default')}
            </SelectItem>
            <SelectItem value="merge" className="text-xs">
              {translate('fork.hostedReviewSitter.enrollment.mergeCommit', 'Merge commit')}
            </SelectItem>
            <SelectItem value="squash" className="text-xs">
              {translate('fork.hostedReviewSitter.enrollment.mergeSquash', 'Squash and merge')}
            </SelectItem>
            <SelectItem value="rebase" className="text-xs">
              {translate('fork.hostedReviewSitter.enrollment.mergeRebase', 'Rebase and merge')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <label htmlFor={budgetInputId} className="text-[10px] font-medium text-muted-foreground">
          {translate(
            'fork.hostedReviewSitter.enrollment.activeBudget',
            'Active-time budget (hours)'
          )}
        </label>
        <Input
          id={budgetInputId}
          type="number"
          step={0.25}
          value={Number.isFinite(activeBudgetHours) ? activeBudgetHours : ''}
          disabled={busy}
          aria-invalid={!validBudget}
          onChange={(event) => onActiveBudgetHoursChange(event.currentTarget.valueAsNumber)}
          className="h-7 px-2 text-[11px]"
        />
        <p className="text-[10px] text-muted-foreground">
          {translate(
            'fork.hostedReviewSitter.enrollment.budgetHelp',
            'Counts only while Orca is running. Default: 4 hours.'
          )}
        </p>
      </div>

      {blockedReason ? (
        <div className="flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{blockedReason}</span>
        </div>
      ) : null}
      <Button
        type="button"
        size="xs"
        className="w-full"
        disabled={busy || Boolean(blockedReason) || !validBudget}
        onClick={onArm}
      >
        {arming ? <Loader2 className="animate-spin" /> : <Bot />}
        {rearming
          ? translate('fork.hostedReviewSitter.enrollment.rearm', 'Re-arm PR Sitter')
          : translate('fork.hostedReviewSitter.enrollment.arm', 'Arm PR Sitter')}
      </Button>
    </div>
  )
}
