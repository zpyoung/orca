import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { objectiveWorkspaceKindLabel } from './objective-copy'
import type { ObjectiveWorkspaceOption } from './objective-workspace-options'

type WorkspaceFilter = 'all' | 'git' | 'folder'

type WorkspaceGroup = {
  key: string
  path: string
  options: ObjectiveWorkspaceOption[]
}

export type ObjectiveWorkspacePickerProps = {
  value: string
  workspaces: readonly ObjectiveWorkspaceOption[]
  disabled: boolean
  labelledBy: string
  onChange: (key: string) => void
}

function matchesQuery(workspace: ObjectiveWorkspaceOption, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return true
  }
  const searchText = [
    workspace.label,
    workspace.repoPath,
    workspace.workspacePath,
    workspace.branch,
    workspace.detail
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLocaleLowerCase()
  return terms.every((term) => searchText.includes(term))
}

function groupWorkspaces(workspaces: readonly ObjectiveWorkspaceOption[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const workspace of workspaces) {
    const key = `${workspace.repoId}\0${workspace.repoPath}`
    const group = groups.get(key)
    if (group) {
      group.options.push(workspace)
    } else {
      groups.set(key, { key, path: workspace.repoPath, options: [workspace] })
    }
  }
  return [...groups.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function ObjectiveWorkspacePicker({
  value,
  workspaces,
  disabled,
  labelledBy,
  onChange
}: ObjectiveWorkspacePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<WorkspaceFilter>('all')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const selected = workspaces.find((workspace) => workspace.key === value) ?? null
  const groups = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const visible = workspaces.filter(
      (workspace) =>
        (filter === 'all' || workspace.workspaceKind === filter) && matchesQuery(workspace, terms)
    )
    return groupWorkspaces(visible)
  }, [filter, query, workspaces])

  const cancelFocusFrame = useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  useEffect(() => cancelFocusFrame, [cancelFocusFrame])

  const focusSearchInput = useCallback((): void => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
    })
  }, [cancelFocusFrame])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (!nextOpen) {
        cancelFocusFrame()
        setQuery('')
      }
    },
    [cancelFocusFrame]
  )

  const handleSelect = useCallback(
    (key: string): void => {
      onChange(key)
      setOpen(false)
      setQuery('')
    },
    [onChange]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-labelledby={labelledBy}
          disabled={disabled}
          className="h-9 w-full justify-between px-3 text-sm font-normal"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.label ??
              translate('fork.heimdallObjective.workspacePicker.placeholder', 'Choose a workspace')}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[22rem] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusSearchInput()
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            aria-label={translate(
              'fork.heimdallObjective.workspacePicker.searchLabel',
              'Search workspaces'
            )}
            placeholder={translate(
              'fork.heimdallObjective.workspacePicker.searchPlaceholder',
              'Search by name, path, branch, or host…'
            )}
          />
          <div className="border-b border-border bg-muted/20 p-1.5">
            <ToggleGroup
              type="single"
              spacing={1}
              size="sm"
              value={filter}
              aria-label={translate(
                'fork.heimdallObjective.workspacePicker.filterLabel',
                'Filter workspaces'
              )}
              onValueChange={(nextFilter) => {
                if (nextFilter) {
                  setFilter(nextFilter as WorkspaceFilter)
                }
              }}
            >
              <ToggleGroupItem value="all" className="h-7 px-2 text-xs">
                {translate('fork.heimdallObjective.workspacePicker.filterAll', 'All')}
              </ToggleGroupItem>
              <ToggleGroupItem value="git" className="h-7 px-2 text-xs">
                {translate('fork.heimdallObjective.workspacePicker.filterGit', 'Git worktrees')}
              </ToggleGroupItem>
              <ToggleGroupItem value="folder" className="h-7 px-2 text-xs">
                {translate('fork.heimdallObjective.workspacePicker.filterFolders', 'Folders')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <CommandList className="max-h-[min(20rem,50vh)]">
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
                {translate(
                  'fork.heimdallObjective.workspacePicker.noMatches',
                  'No eligible workspaces match.'
                )}
              </div>
            ) : null}
            {groups.map((group) => (
              <CommandGroup key={group.key} heading={group.path}>
                {group.options.map((workspace) => (
                  <CommandItem
                    key={workspace.key}
                    value={workspace.key}
                    disabled={workspace.ownerUnavailable}
                    onSelect={() => handleSelect(workspace.key)}
                    className="jump-palette-item items-start py-2"
                  >
                    <Check
                      className={cn(
                        'mt-0.5 size-3.5 shrink-0',
                        value === workspace.key ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{workspace.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {objectiveWorkspaceKindLabel(workspace.workspaceKind)} · {workspace.detail}
                        {workspace.branch ? ` · ${workspace.branch}` : ''}
                        {workspace.ownerUnavailable
                          ? ` · ${translate(
                              'fork.heimdallObjective.enrollment.ownerUnavailableShort',
                              'Owner unavailable'
                            )}`
                          : ''}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
