import { Check, ChevronsUpDown, GitBranchPlus } from 'lucide-react'
import { useState } from 'react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { ForkHandoffRelationship } from '../../../../../shared/fork-session-handoff/session-lineage-types'

export type HandoffDestinationOption = {
  id: string
  name: string
  path: string
}

type HandoffDestinationControlsProps = {
  disabled: boolean
  targets: HandoffDestinationOption[]
  targetWorktreeId: string
  targetPath: string | null
  onTargetChange: (worktreeId: string) => void
  createMode: boolean
  canCreateWorktree: boolean
  createName: string
  createBaseBranch: string
  onCreateModeChange: (enabled: boolean) => void
  onCreateNameChange: (value: string) => void
  onCreateBaseBranchChange: (value: string) => void
  relationship: ForkHandoffRelationship
  onRelationshipChange: (relationship: ForkHandoffRelationship) => void
  agents: AgentCatalogEntry[]
  selectedAgent: TuiAgent | null
  onAgentChange: (agent: TuiAgent | null) => void
  detectingAgents: boolean
  agentDetectionFailed: boolean
}

export function HandoffDestinationControls({
  disabled,
  targets,
  targetWorktreeId,
  targetPath,
  onTargetChange,
  createMode,
  canCreateWorktree,
  createName,
  createBaseBranch,
  onCreateModeChange,
  onCreateNameChange,
  onCreateBaseBranchChange,
  relationship,
  onRelationshipChange,
  agents,
  selectedAgent,
  onAgentChange,
  detectingAgents,
  agentDetectionFailed
}: HandoffDestinationControlsProps): React.JSX.Element {
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const selectedTarget = targets.find((target) => target.id === targetWorktreeId) ?? null

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-60">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate(
          'components.agentSessionContinuation.forkSessionHandoff.destination',
          'Destination'
        )}
      </legend>

      <div className="space-y-1.5">
        <Label htmlFor="handoff-target-worktree" className="text-xs">
          {translate('components.agentSessionContinuation.forkSessionHandoff.worktree', 'Worktree')}
        </Label>
        <Popover open={targetPickerOpen} onOpenChange={setTargetPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              id="handoff-target-worktree"
              type="button"
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={targetPickerOpen}
              disabled={createMode}
              className="w-full min-w-0 justify-between font-normal"
            >
              <span className="truncate">{selectedTarget?.name}</span>
              <ChevronsUpDown
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
            <Command>
              <CommandInput
                placeholder={translate(
                  'components.agentSessionContinuation.forkSessionHandoff.searchWorktrees',
                  'Search worktrees…'
                )}
              />
              <CommandList>
                <CommandEmpty>
                  {translate(
                    'components.agentSessionContinuation.forkSessionHandoff.noMatchingWorktrees',
                    'No matching worktrees.'
                  )}
                </CommandEmpty>
                {targets.map((target) => (
                  <CommandItem
                    key={target.id}
                    value={`${target.name} ${target.path}`}
                    onSelect={() => {
                      onTargetChange(target.id)
                      setTargetPickerOpen(false)
                    }}
                    className="gap-2"
                  >
                    <Check
                      className={
                        target.id === targetWorktreeId ? 'size-4 opacity-100' : 'size-4 opacity-0'
                      }
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{target.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {target.path}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {!createMode && targetPath ? (
          <p className="break-all font-mono text-[11px] text-muted-foreground">{targetPath}</p>
        ) : null}
      </div>

      {canCreateWorktree ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            aria-expanded={createMode}
            onClick={() => onCreateModeChange(!createMode)}
          >
            <GitBranchPlus className="size-4" aria-hidden="true" />
            {createMode
              ? translate(
                  'components.agentSessionContinuation.forkSessionHandoff.useExistingWorktree',
                  'Use an existing worktree'
                )
              : translate(
                  'components.agentSessionContinuation.forkSessionHandoff.createWorktree',
                  'Create a new worktree'
                )}
          </Button>
          {createMode ? (
            <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="handoff-worktree-name" className="text-[11px]">
                  {translate(
                    'components.agentSessionContinuation.forkSessionHandoff.worktreeName',
                    'Worktree name'
                  )}
                </Label>
                <Input
                  id="handoff-worktree-name"
                  value={createName}
                  onChange={(event) => onCreateNameChange(event.target.value)}
                  placeholder={translate(
                    'components.agentSessionContinuation.forkSessionHandoff.worktreeNamePlaceholder',
                    'handoff-follow-up'
                  )}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="handoff-base-branch" className="text-[11px]">
                  {translate(
                    'components.agentSessionContinuation.forkSessionHandoff.baseBranch',
                    'Base branch (optional)'
                  )}
                </Label>
                <Input
                  id="handoff-base-branch"
                  value={createBaseBranch}
                  onChange={(event) => onCreateBaseBranchChange(event.target.value)}
                  placeholder={translate(
                    'components.agentSessionContinuation.forkSessionHandoff.baseBranchPlaceholder',
                    'Current branch'
                  )}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1.5" role="group" aria-labelledby="handoff-agent-label">
        <Label id="handoff-agent-label" className="text-xs">
          {translate('components.agentSessionContinuation.forkSessionHandoff.agent', 'Agent')}
        </Label>
        <AgentCombobox
          agents={agents}
          value={selectedAgent}
          onValueChange={onAgentChange}
          allowBlankTerminal={false}
          allowNarrowTrigger
          emptyLabel={translate(
            'components.agentSessionContinuation.forkSessionHandoff.selectAgent',
            'Select an Agent'
          )}
          triggerClassName="w-full min-w-0"
        />
        <AgentAvailabilityMessage
          detecting={detectingAgents}
          failed={agentDetectionFailed}
          empty={!detectingAgents && !agentDetectionFailed && agents.length === 0}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="handoff-relationship" className="text-xs">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.relationship',
            'Relationship'
          )}
        </Label>
        <Select
          value={relationship}
          onValueChange={(value) => onRelationshipChange(value as ForkHandoffRelationship)}
        >
          <SelectTrigger id="handoff-relationship" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="continues">
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.relationshipContinues',
                'Continues'
              )}
            </SelectItem>
            <SelectItem value="reviews">
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.relationshipReviews',
                'Reviews'
              )}
            </SelectItem>
            <SelectItem value="branches-from">
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.relationshipBranches',
                'Branches from'
              )}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </fieldset>
  )
}

function AgentAvailabilityMessage({
  detecting,
  failed,
  empty
}: {
  detecting: boolean
  failed: boolean
  empty: boolean
}): React.JSX.Element | null {
  if (detecting) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'components.agentSessionContinuation.forkSessionHandoff.detectingAgents',
          'Detecting Agents on the target host…'
        )}
      </p>
    )
  }
  if (failed) {
    return (
      <p className="text-[11px] text-destructive">
        {translate(
          'components.agentSessionContinuation.forkSessionHandoff.agentDetectionFailed',
          'Could not detect Agents on the target host.'
        )}
      </p>
    )
  }
  return empty ? (
    <p className="text-[11px] text-muted-foreground">
      {translate(
        'components.agentSessionContinuation.forkSessionHandoff.noAgents',
        'No enabled Agents were detected on the target host.'
      )}
    </p>
  ) : null
}
