import { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AgentFamily } from '../../../../../shared/review/agent-family'
import type { ReviewDepth, ReviewProfile } from '../../../../../shared/review/stage-schemas'
import type { GlobalSettings, TuiAgent } from '../../../../../shared/types'
import type {
  ReviewLaunchPlan,
  ReviewLaunchRequest,
  ReviewLaunchTargetKind
} from './adversarial-review-model'
import { useAdversarialReviewLaunchState } from './useAdversarialReviewLaunchState'
import { translate } from '@/i18n/i18n'

const EMPTY_AGENT_OPTIONS: AgentCatalogEntry[] = []

const GIT_TARGETS: { value: ReviewLaunchTargetKind; label: string }[] = [
  {
    value: 'worktree',
    label: translate('adversarialReview.launch.target.worktree', 'Current worktree')
  },
  { value: 'branch', label: translate('adversarialReview.launch.target.branch', 'Branch vs base') },
  { value: 'hosted', label: translate('adversarialReview.launch.target.hosted', 'Hosted review') },
  { value: 'commit', label: translate('adversarialReview.launch.target.commit', 'Commit') },
  { value: 'path', label: translate('adversarialReview.launch.target.path', 'Path') },
  { value: 'custom', label: translate('adversarialReview.launch.target.custom', 'Custom target') }
]
const FOLDER_TARGETS = GIT_TARGETS.filter(
  (target) => target.value === 'path' || target.value === 'custom'
)

export type AdversarialReviewLaunchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  isFolderWorkspace: boolean
  initialTargetKind?: ReviewLaunchTargetKind
  initialTarget?: string
  inferredProfile?: ReviewProfile
  suggestedDepth?: ReviewDepth
  inferredAuthorFamily?: AgentFamily
  autoReviewer?: TuiAgent | null
  agentOptions?: AgentCatalogEntry[]
  plan?: ReviewLaunchPlan | null
  settings?: Pick<GlobalSettings, 'adversarialReview'> | null
  launchDisabledReason?: string | null
  onLaunch: (request: ReviewLaunchRequest) => void | Promise<void>
  onSaveDefaults?: (
    defaults: NonNullable<GlobalSettings['adversarialReview']>
  ) => void | Promise<void>
}

export function AdversarialReviewLaunchDialog({
  open,
  onOpenChange,
  isFolderWorkspace,
  initialTargetKind,
  initialTarget = 'WORKTREE',
  inferredProfile = 'code-diff',
  suggestedDepth = 'standard',
  inferredAuthorFamily = 'other',
  autoReviewer = null,
  agentOptions = EMPTY_AGENT_OPTIONS,
  plan = null,
  settings,
  launchDisabledReason = null,
  onLaunch,
  onSaveDefaults
}: AdversarialReviewLaunchDialogProps): React.JSX.Element {
  const targets = isFolderWorkspace ? FOLDER_TARGETS : GIT_TARGETS
  const defaultTargetKind = initialTargetKind ?? (isFolderWorkspace ? 'path' : 'worktree')
  const defaults = useMemo(
    () => ({
      targetKind: targets.some((item) => item.value === defaultTargetKind)
        ? defaultTargetKind
        : targets[0].value,
      target: initialTarget,
      profile: inferredProfile,
      depth: settings?.adversarialReview?.defaultDepth ?? suggestedDepth,
      authorFamily: settings?.adversarialReview?.authorFamilyOverride ?? inferredAuthorFamily,
      reviewer: settings?.adversarialReview?.defaultReviewer ?? autoReviewer
    }),
    [
      autoReviewer,
      defaultTargetKind,
      inferredAuthorFamily,
      inferredProfile,
      initialTarget,
      settings?.adversarialReview?.authorFamilyOverride,
      settings?.adversarialReview?.defaultDepth,
      settings?.adversarialReview?.defaultReviewer,
      suggestedDepth,
      targets
    ]
  )
  const state = useAdversarialReviewLaunchState(open, defaults)
  const canLaunch = state.request.criteria.trim().length > 0 && !launchDisabledReason

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate('adversarialReview.launch.title', 'Start adversarial review')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'adversarialReview.launch.description',
              "A separate agent family reviews the resolved artifact without the author's rationale."
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(65vh,36rem)] space-y-4 overflow-y-auto pr-1 scrollbar-sleek">
          <div className="grid gap-2">
            <Label className="text-xs">
              {translate('adversarialReview.launch.target.label', 'Target')}
            </Label>
            <Select
              value={state.request.targetKind}
              onValueChange={(value) => state.setTargetKind(value as ReviewLaunchTargetKind)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.value} value={target.value}>
                    {target.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={state.request.target}
              onChange={(event) => state.setTarget(event.target.value)}
              className="font-mono text-xs"
              placeholder={
                isFolderWorkspace
                  ? translate(
                      'adversarialReview.launch.target.folderPlaceholder',
                      'Path or custom target'
                    )
                  : translate('adversarialReview.launch.target.worktreePlaceholder', 'WORKTREE')
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adversarial-review-criteria" className="text-xs">
              {translate('adversarialReview.launch.criteria.label', 'Criteria')}
            </Label>
            <textarea
              id="adversarial-review-criteria"
              rows={5}
              value={state.request.criteria}
              onChange={(event) => state.setCriteria(event.target.value)}
              placeholder={translate(
                'adversarialReview.launch.criteria.placeholder',
                'Paste the task contract or acceptance criteria verbatim.'
              )}
              className="w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
            <p className="text-[11px] leading-4 text-muted-foreground">
              {translate(
                'adversarialReview.launch.criteria.help',
                'Criteria is never inferred from commit messages or author reasoning.'
              )}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ReviewSelect
              label={translate('adversarialReview.launch.profile', 'Profile')}
              value={state.request.profile}
              options={['code-diff', 'spec-design', 'plan', 'prose-claim']}
              onChange={(value) => state.setProfile(value as ReviewProfile)}
            />
            <ReviewSelect
              label={translate('adversarialReview.launch.depth', 'Depth')}
              value={state.request.depth}
              options={['quick', 'standard', 'deep']}
              onChange={(value) => state.setDepth(value as ReviewDepth)}
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-xs">
              {translate('adversarialReview.launch.authorFamily', 'Author family')}
            </Label>
            <Select
              value={state.request.authorFamily}
              onValueChange={(value) => state.setAuthorFamily(value as AgentFamily)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['anthropic', 'openai', 'google', 'other'].map((family) => (
                  <SelectItem key={family} value={family}>
                    {family}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label className="text-xs">
              {translate('adversarialReview.launch.reviewer', 'Reviewer')}
            </Label>
            <AgentCombobox
              agents={agentOptions}
              value={state.request.reviewer}
              onValueChange={state.setReviewer}
              allowBlankTerminal={false}
              allowNarrowTrigger
              triggerClassName="w-full"
              emptyLabel="Auto-pick a cross-family reviewer"
            />
          </div>
          {plan ? (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <p className="font-medium">{plan.stageSummary}</p>
              <div>
                <p className="text-muted-foreground">
                  {translate('adversarialReview.launch.prepass', 'Pre-pass commands')}
                </p>
                {plan.prepassCommands.length ? (
                  <ul className="mt-1 space-y-1 font-mono">
                    {plan.prepassCommands.map((command) => (
                      <li key={command}>{command}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    {translate('adversarialReview.launch.noCommands', 'No commands detected')}
                  </p>
                )}
              </div>
              {plan.activeSessionWarning ? (
                <p className="flex gap-1.5 text-muted-foreground">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  {plan.activeSessionWarning}
                </p>
              ) : null}
            </div>
          ) : null}
          {launchDisabledReason ? (
            <p className="text-xs text-destructive">{launchDisabledReason}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {translate('adversarialReview.launch.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canLaunch}
            onClick={() => {
              void Promise.resolve(
                onSaveDefaults?.({
                  defaultDepth: state.request.depth,
                  defaultReviewer: state.request.reviewer ?? undefined,
                  authorFamilyOverride: state.request.authorFamily
                })
              )
              void Promise.resolve(onLaunch(state.request)).then(() => onOpenChange(false))
            }}
          >
            {translate('adversarialReview.launch.start', 'Start review')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReviewSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-2">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
