import { useEffect, useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'
import {
  isValidWorkspaceActivityCustomDays,
  isWorkspaceActivityWindow
} from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'

export function WorkspaceActivityWindowControl() {
  const controlId = useId()
  const windowId = `${controlId}-window`
  const customDaysId = `${controlId}-custom-days`
  const customDaysErrorId = `${controlId}-custom-days-error`
  const windowOptions: { value: WorkspaceActivityWindow; label: string }[] = [
    {
      value: 'all',
      label: translate('auto.components.sidebar.WorkspaceActivityWindowControl.all', 'All')
    },
    {
      value: 'live-only',
      label: translate(
        'auto.components.sidebar.WorkspaceActivityWindowControl.live-only',
        'Live only'
      )
    },
    {
      value: 'today',
      label: translate(
        'auto.components.sidebar.WorkspaceActivityWindowControl.today',
        'Past 24 hours'
      )
    },
    {
      value: 'week',
      label: translate('auto.components.sidebar.WorkspaceActivityWindowControl.week', 'Past 7 days')
    },
    {
      value: 'month',
      label: translate(
        'auto.components.sidebar.WorkspaceActivityWindowControl.month',
        'Past 30 days'
      )
    },
    {
      value: 'custom',
      label: translate('auto.components.sidebar.WorkspaceActivityWindowControl.custom', 'Custom')
    }
  ]
  const window = useAppStore((state) => state.workspaceActivityWindow)
  const customDays = useAppStore((state) => state.workspaceActivityCustomDays)
  const setWindow = useAppStore((state) => state.setWorkspaceActivityWindow)
  const setCustomDays = useAppStore((state) => state.setWorkspaceActivityCustomDays)
  const [draft, setDraft] = useState(String(customDays))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (window === 'custom') {
      setDraft(String(customDays))
      setInvalid(false)
    }
  }, [window, customDays])

  const commitCustomDays = () => {
    if (!/^\d+$/.test(draft)) {
      setInvalid(true)
      return
    }
    const value = Number(draft)
    if (!isValidWorkspaceActivityCustomDays(value)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setCustomDays(value)
  }

  return (
    <div className="space-y-2 px-2 py-1.5">
      <Label htmlFor={windowId} className="text-xs">
        {translate(
          'auto.components.sidebar.WorkspaceActivityWindowControl.activityWindow',
          'Activity window'
        )}
      </Label>
      <Select
        value={window}
        onValueChange={(value) => {
          if (isWorkspaceActivityWindow(value)) {
            setWindow(value)
          }
        }}
      >
        <SelectTrigger id={windowId} size="sm" className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {windowOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {window === 'custom' && (
        <div className="space-y-1">
          <Label htmlFor={customDaysId} className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorkspaceActivityWindowControl.customDays',
              'Custom days'
            )}
          </Label>
          <Input
            id={customDaysId}
            type="text"
            inputMode="numeric"
            value={draft}
            aria-invalid={invalid}
            aria-describedby={invalid ? customDaysErrorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalid(false)
            }}
            onBlur={commitCustomDays}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitCustomDays()
              }
            }}
            className="h-8 text-xs"
          />
          {invalid && (
            <p id={customDaysErrorId} className="text-[11px] text-destructive">
              {translate(
                'auto.components.sidebar.WorkspaceActivityWindowControl.customDaysError',
                'Enter a positive whole number.'
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
