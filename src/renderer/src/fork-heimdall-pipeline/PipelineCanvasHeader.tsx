import type { JSX } from 'react'
import { Copy, Play, Save } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { PipelineCanvasRunOption } from './pipeline-canvas-run-session'

export type PipelineCanvasView = 'graph' | 'yaml'
export type PipelineCanvasMode = 'edit' | 'run'
export type PipelineRunOption = PipelineCanvasRunOption

export function PipelineCanvasHeader({
  name,
  dirty,
  readOnly,
  saving,
  scope,
  view,
  mode,
  runOptions,
  selectedRunId,
  differsFromSaved,
  runDisabled,
  onNameChange,
  onSave,
  onDuplicate,
  onViewChange,
  onModeChange,
  onRunSelect,
  onRunPipeline
}: {
  name: string
  dirty: boolean
  readOnly: boolean
  saving: boolean
  scope: 'repo' | 'builtin' | 'user'
  view: PipelineCanvasView
  mode: PipelineCanvasMode
  runOptions: readonly PipelineRunOption[]
  selectedRunId: string | null
  differsFromSaved: boolean
  runDisabled: boolean
  onNameChange: (name: string) => void
  onSave: () => void
  onDuplicate: () => void
  onViewChange: (view: PipelineCanvasView) => void
  onModeChange: (mode: PipelineCanvasMode) => void
  onRunSelect: (watcherId: string) => void
  onRunPipeline: () => void
}): JSX.Element {
  const selectedRun = runOptions.find((run) => run.watcherId === selectedRunId) ?? runOptions[0]
  const runNumber =
    selectedRun?.runNumber === null || selectedRun?.runNumber === undefined
      ? '—'
      : String(selectedRun.runNumber)
  return (
    <header className="pipeline-canvas-header">
      <div className="pipeline-canvas-header__identity">
        <Input
          aria-label={translate('fork.heimdallPipeline.header.name', 'Pipeline name')}
          value={name}
          disabled={readOnly}
          onChange={(event) => onNameChange(event.target.value)}
          className="w-[min(24rem,34vw)]"
        />
        {scope === 'builtin' ? (
          <Badge variant="secondary">
            {translate('fork.heimdallPipeline.header.builtin', 'Built-in')}
          </Badge>
        ) : scope === 'user' ? (
          <Badge variant="outline">
            {translate('fork.heimdallPipeline.header.personal', 'Personal')}
          </Badge>
        ) : null}
        {dirty ? (
          <span className="pipeline-canvas-header__dirty" role="status">
            {translate('fork.heimdallPipeline.header.edited', 'Edited')}
          </span>
        ) : null}
        {mode === 'run' && differsFromSaved ? (
          <Badge variant="outline">
            {translate('fork.heimdallPipeline.header.differsFromSaved', 'Differs from saved')}
          </Badge>
        ) : null}
      </div>
      <div className="pipeline-canvas-header__actions">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={mode}
          aria-label={translate('fork.heimdallPipeline.header.mode', 'Pipeline mode')}
          onValueChange={(next) => {
            if (next === 'edit' || next === 'run') {
              onModeChange(next)
            }
          }}
        >
          <ToggleGroupItem value="edit">
            {translate('fork.heimdallPipeline.header.edit', 'Edit')}
          </ToggleGroupItem>
          <ToggleGroupItem value="run" disabled={runOptions.length === 0}>
            {translate('fork.heimdallPipeline.header.runNumber', 'Run (#{{number}})', {
              number: runNumber
            })}
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === 'edit' ? (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={view}
            aria-label={translate('fork.heimdallPipeline.header.view', 'Canvas view')}
            onValueChange={(next) => {
              if (next === 'graph' || next === 'yaml') {
                onViewChange(next)
              }
            }}
          >
            <ToggleGroupItem value="graph">
              {translate('fork.heimdallPipeline.header.graph', 'Graph')}
            </ToggleGroupItem>
            <ToggleGroupItem value="yaml">
              {translate('fork.heimdallPipeline.header.yaml', 'YAML')}
            </ToggleGroupItem>
          </ToggleGroup>
        ) : runOptions.length > 1 ? (
          <Select value={selectedRunId ?? selectedRun?.watcherId ?? ''} onValueChange={onRunSelect}>
            <SelectTrigger
              className="w-auto"
              aria-label={translate(
                'fork.heimdallPipeline.header.selectRun',
                'Select pipeline run'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {runOptions.map((run) => (
                <SelectItem key={run.watcherId} value={run.watcherId}>
                  {translate('fork.heimdallPipeline.header.runNumber', 'Run (#{{number}})', {
                    number: run.runNumber === null ? '—' : run.runNumber
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {scope === 'builtin' ? (
          <Button variant="outline" size="sm" onClick={onDuplicate}>
            <Copy aria-hidden="true" />
            {translate('fork.heimdallPipeline.header.duplicateToRepo', 'Duplicate to repo')}
          </Button>
        ) : null}
        {mode === 'edit' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runDisabled}
            onClick={onRunPipeline}
          >
            <Play aria-hidden="true" />
            {translate('fork.heimdallPipeline.header.runPipeline', 'Run pipeline')}
          </Button>
        ) : null}
        {!readOnly && mode === 'edit' ? (
          <Button size="sm" onClick={onSave} disabled={saving}>
            <Save aria-hidden="true" />
            {saving
              ? translate('fork.heimdallPipeline.header.saving', 'Saving…')
              : translate('fork.heimdallPipeline.header.save', 'Save')}
          </Button>
        ) : null}
      </div>
    </header>
  )
}
