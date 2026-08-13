import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ensurePipelineTab } from '@/lib/ensure-pipeline-tab'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

type PipelineTemplateEntry = Awaited<ReturnType<typeof window.api.pipelines.listTemplates>>[number]
type PipelineTemplateResolveResult = Awaited<
  ReturnType<typeof window.api.pipelines.resolveTemplate>
>
type PipelineStartResult =
  | { runId: string; runNumber: number; branch?: string }
  | { refused: { nodeId?: string; field?: string; message: string } }

type PipelineRunListEntry = {
  runId: string
  templateName: string
  runNumber: number
  state: string
  workspaceDisplayName: string
  workspaceId?: string
}

export type PipelineStartDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Originating workspace selector, e.g. `id:<worktreeId>`, forwarded verbatim to `pipeline.start`. */
  worktreeSelector: string
  /** Raw worktree id (unprefixed), used to scope the run-history list. Omit to list every run. */
  workspaceId?: string
  target: RuntimeClientTarget
  isFolderWorkspace: boolean
  hasSubmodules: boolean
  onStarted?: (result: {
    runId: string
    runNumber: number
    branch?: string
    templateName: string
  }) => void
}

function describeResolveError(
  error: Extract<PipelineTemplateResolveResult, { ok: false }>['error']
): string {
  if (error.kind === 'template_error') {
    return error.detail.message
  }
  if (error.kind === 'template_not_found') {
    return translate(
      'auto.components.pipeline.canvas.PipelineStartDialog.notFound',
      'That template no longer exists in ~/.orca/pipelines/.'
    )
  }
  return translate(
    'auto.components.pipeline.canvas.PipelineStartDialog.invalidBasename',
    'Invalid template selection.'
  )
}

/** Template list, free-text input, "needs a newer Orca" flag, folder-workspace and submodule warnings. */
export default function PipelineStartDialog({
  open,
  onOpenChange,
  worktreeSelector,
  workspaceId,
  target,
  isFolderWorkspace,
  hasSubmodules,
  onStarted
}: PipelineStartDialogProps): React.JSX.Element {
  const [templates, setTemplates] = useState<PipelineTemplateEntry[] | null>(null)
  const [runHistory, setRunHistory] = useState<PipelineRunListEntry[]>([])
  const [selectedBasename, setSelectedBasename] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setTemplates(null)
    setErrorMessage(null)
    void window.api.pipelines.listTemplates().then((entries) => {
      if (!cancelled) {
        setTemplates(entries)
      }
    })
    void callRuntimeRpc<{ runs: PipelineRunListEntry[] }>(
      target,
      'pipeline.listRuns',
      workspaceId ? { workspaceId } : {}
    )
      .then((result) => {
        if (!cancelled) {
          setRunHistory(result.runs)
        }
      })
      .catch(() => {
        // Why: history is a convenience list; a failed fetch must not block starting a new run.
      })
    return () => {
      cancelled = true
    }
  }, [open, target, workspaceId])

  const selected = templates?.find((entry) => entry.basename === selectedBasename) ?? null
  const canSubmit = selected !== null && inputText.trim().length > 0 && !submitting

  const handleSubmit = async (): Promise<void> => {
    if (!selected) {
      return
    }
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const resolved = await window.api.pipelines.resolveTemplate({
        basename: selected.basename,
        inputText
      })
      if (!resolved.ok) {
        setErrorMessage(describeResolveError(resolved.error))
        return
      }
      const result = await callRuntimeRpc<PipelineStartResult>(target, 'pipeline.start', {
        worktree: worktreeSelector,
        definition: resolved.definition
      })
      if ('refused' in result) {
        setErrorMessage(result.refused.message)
        return
      }
      onStarted?.({ ...result, templateName: resolved.definition.templateName })
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.pipeline.canvas.PipelineStartDialog.title', 'Run pipeline')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.pipeline.canvas.PipelineStartDialog.description',
              'Pick a template and describe the input. The run starts in a new worktree on this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>

        {isFolderWorkspace && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.pipeline.canvas.PipelineStartDialog.folderWarning',
              'This is a folder workspace: the run executes forward-only in the folder itself, with no worktree and no checkpoints to roll back to on retry or Abort.'
            )}
          </p>
        )}
        {hasSubmodules && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.pipeline.canvas.PipelineStartDialog.submoduleWarning',
              'This repository has submodules: submodule contents are not checkpointed, so retries do not roll back submodule changes.'
            )}
          </p>
        )}

        <div
          className="scrollbar-sleek flex max-h-48 flex-col gap-1 overflow-y-auto"
          role="listbox"
          aria-label={translate(
            'auto.components.pipeline.canvas.PipelineStartDialog.templates',
            'Templates'
          )}
        >
          {templates === null && (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.pipeline.canvas.PipelineStartDialog.loading',
                'Loading templates…'
              )}
            </p>
          )}
          {templates?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.pipeline.canvas.PipelineStartDialog.empty',
                'No templates found in ~/.orca/pipelines/.'
              )}
            </p>
          )}
          {templates?.map((entry) => (
            <button
              key={entry.basename}
              type="button"
              role="option"
              aria-selected={selectedBasename === entry.basename}
              onClick={() => setSelectedBasename(entry.basename)}
              className={cn(
                'rounded-md border px-3 py-2 text-left transition-colors',
                selectedBasename === entry.basename
                  ? 'border-ring bg-accent'
                  : 'border-border hover:bg-accent'
              )}
            >
              <div className="text-sm font-medium text-foreground">{entry.name}</div>
              {entry.description && (
                <div className="text-xs text-muted-foreground">{entry.description}</div>
              )}
              {entry.needsNewerOrca && (
                <div className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.pipeline.canvas.PipelineStartDialog.needsNewerOrca',
                    'This template may need a newer Orca'
                  )}
                </div>
              )}
              {entry.error && <div className="text-xs text-destructive">{entry.error.message}</div>}
            </button>
          ))}
        </div>

        {runHistory.length > 0 && (
          <section
            aria-label={translate(
              'auto.components.pipeline.canvas.PipelineStartDialog.recentRuns',
              'Recent runs'
            )}
            className="scrollbar-sleek flex max-h-24 flex-col gap-0.5 overflow-y-auto text-xs text-muted-foreground"
          >
            {runHistory.map((run) => {
              const rowContent = (
                <>
                  <span>
                    {run.workspaceDisplayName} #{run.runNumber}
                  </span>
                  <span>{run.state}</span>
                </>
              )
              const ownerWorktreeId = run.workspaceId ?? workspaceId
              if (!ownerWorktreeId) {
                return (
                  <div key={run.runId} className="flex items-center justify-between gap-2">
                    {rowContent}
                  </div>
                )
              }
              return (
                <button
                  key={run.runId}
                  type="button"
                  onClick={() => {
                    ensurePipelineTab(ownerWorktreeId, {
                      runId: run.runId,
                      runNumber: run.runNumber,
                      templateName: run.templateName
                    })
                    onOpenChange(false)
                  }}
                  className="flex items-center justify-between gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {rowContent}
                </button>
              )
            })}
          </section>
        )}

        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          {translate('auto.components.pipeline.canvas.PipelineStartDialog.input', 'Input')}
          <textarea
            aria-label={translate(
              'auto.components.pipeline.canvas.PipelineStartDialog.input',
              'Input'
            )}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            rows={4}
            className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </label>

        {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.pipeline.canvas.PipelineStartDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {translate('auto.components.pipeline.canvas.PipelineStartDialog.start', 'Start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
