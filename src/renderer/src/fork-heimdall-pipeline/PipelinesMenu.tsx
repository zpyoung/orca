import { useEffect, useState } from 'react'
import { Check, GitBranchPlus, MoreHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  BUILTIN_PIPELINE_TEXTS,
  type BuiltinPipelineId
} from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import { layeredLayout } from './layered-layout'
import { renderPipelineLayoutForDocument } from './pipeline-canvas-document-edits'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { getObjectiveHeimdallApi } from '../fork-heimdall-objective/objective-heimdall-api'
import {
  copyPipelineSource,
  deletePersonalPipeline,
  deleteRepoPipeline,
  listPersonalPipelines,
  listRepoPipelineIds,
  nextFreePipelineId,
  readPersonalPipeline,
  writePersonalPipeline,
  writeRepoPipeline
} from './pipeline-file-io'
import { openPipelineTab } from './open-pipeline-tab'
import { listPipelineChoices, type PipelinePickerChoice } from './PipelinePicker'
import { ensurePipelineTracked, type PipelineTrackingResult } from './pipeline-tab-save'
import { PipelineTrackingNotice } from './PipelineTrackingNotice'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'
import { disposeClosedPipelineTab } from './pipeline-tab-lifecycle'

export type PipelinesMenuProps = {
  workspace: ObjectiveWorkspaceOption | null
  worktreeId: string | null
  profileId: string | null
}

type CopySource = { sourceText: string; layoutText: string | null }

function isBuiltinPipelineId(id: string): id is BuiltinPipelineId {
  return id === 'objective' || id === 'pr-sitter'
}

async function readCopySource(
  choice: PipelinePickerChoice,
  workspace: ObjectiveWorkspaceOption | null
): Promise<CopySource> {
  if (choice.scope === 'builtin') {
    if (!isBuiltinPipelineId(choice.id)) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.builtinMissing',
          'This built-in pipeline {{id}} is unavailable.',
          { id: choice.id }
        )
      )
    }
    return { sourceText: BUILTIN_PIPELINE_TEXTS[choice.id], layoutText: null }
  }

  if (choice.scope === 'user') {
    const source = await readPersonalPipeline({ id: choice.id })
    if (!source) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.personalUnavailable',
          'Personal pipeline {{id}} is unavailable.',
          { id: choice.id }
        )
      )
    }
    return { sourceText: source.yamlText, layoutText: source.layoutText }
  }
  if (!workspace) {
    throw new Error(
      translate(
        'fork.heimdallObjective.validation.workspaceRequired',
        'Choose a workspace before copying a repository pipeline.'
      )
    )
  }
  const api = getObjectiveHeimdallApi()
  if (typeof api?.pipelineResolve !== 'function') {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.repositoryUnavailable',
        'Repository pipeline service is unavailable on this host.'
      )
    )
  }
  const result = await api.pipelineResolve({
    workspace: { repoId: workspace.repoId, worktreeId: workspace.worktreeId },
    ref: choice.ref
  })
  if (result.scope !== 'repo' || result.id !== choice.id || result.ref !== choice.ref) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.sourceMismatch',
        'Repository pipeline {{id}} resolved to a different source.',
        { id: choice.id }
      )
    )
  }
  return { sourceText: result.sourceText, layoutText: result.layoutText }
}

function copyLayoutText(source: CopySource): string {
  if (source.layoutText !== null) {
    return source.layoutText
  }
  const parsed = parsePipelineText(source.sourceText)
  if (parsed.document === null) {
    throw new Error(parsed.errors.map((error) => error.message).join('\n'))
  }
  return renderPipelineLayoutForDocument(layeredLayout(parsed.document), parsed.document)
}

export function PipelinesMenu({
  workspace,
  worktreeId,
  profileId
}: PipelinesMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<PipelinePickerChoice[]>([])
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [tracking, setTracking] = useState<PipelineTrackingResult | null>(null)
  const [reincludeAvailable, setReincludeAvailable] = useState(false)
  const [trackingPipelineId, setTrackingPipelineId] = useState<string | null>(null)
  const selected = choices.find((choice) => choice.ref === selectedRef) ?? null

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void listPipelineChoices(workspace)
      .then((listing) => {
        if (cancelled) {
          return
        }
        setChoices(listing.choices)
        setError(listing.error)
        setSelectedRef((current) =>
          current && listing.choices.some((choice) => choice.ref === current)
            ? current
            : (listing.choices[0]?.ref ?? null)
        )
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, profileId, workspace])

  const openSelected = (): void => {
    if (!selected || !worktreeId) {
      return
    }
    const opened = openPipelineTab({ scope: selected.scope, worktreeId, id: selected.id })
    if (!opened) {
      setError(
        translate(
          'fork.heimdallPipeline.menu.workspaceUnavailable',
          'The workspace could not be opened.'
        )
      )
      return
    }
    setOpen(false)
  }

  const createNew = async (): Promise<void> => {
    if (!workspace || !worktreeId) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ids = await listRepoPipelineIds(worktreeId)
      const id = nextFreePipelineId('pipeline', ids)
      if (!openPipelineTab({ scope: 'repo', worktreeId, id })) {
        throw new Error(
          translate(
            'fork.heimdallPipeline.menu.workspaceUnavailable',
            'The workspace could not be opened.'
          )
        )
      }
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const copySelected = async (targetScope: 'repo' | 'user'): Promise<void> => {
    if (!selected || !worktreeId || (targetScope === 'repo' && !workspace)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const source = await readCopySource(selected, workspace)
      const existingIds =
        targetScope === 'repo'
          ? await listRepoPipelineIds(worktreeId, selected.ref)
          : (await listPersonalPipelines()).map((pipeline) => pipeline.id)
      const id = nextFreePipelineId(selected.id, existingIds)
      const parsed = parsePipelineText(source.sourceText)
      if (parsed.document === null) {
        throw new Error(parsed.errors.map((validationError) => validationError.message).join('\n'))
      }
      const name =
        `${parsed.document.name} ${translate('fork.heimdallPipeline.menu.copySuffix', 'copy')}`.slice(
          0,
          120
        )
      const yamlText = copyPipelineSource(source.sourceText, id, name)
      const layoutText = copyLayoutText(source)
      if (targetScope === 'repo') {
        await writeRepoPipeline({ worktreeId, id, yamlText, layoutText, ownerRef: selected.ref })
        const trackingResult = await ensurePipelineTracked(worktreeId, id)
        setTracking(trackingResult)
        setTrackingPipelineId(id)
        setReincludeAvailable(false)
      } else {
        const result = await writePersonalPipeline({ id, yamlText, layoutText })
        if (result.status === 'conflict') {
          throw new Error(
            translate(
              'fork.heimdallPipeline.menu.copyConflict',
              'A personal pipeline with that id appeared while copying. Try again.'
            )
          )
        }
      }
      if (!openPipelineTab({ scope: targetScope, worktreeId, id })) {
        throw new Error(
          translate(
            'fork.heimdallPipeline.menu.workspaceUnavailable',
            'The workspace could not be opened.'
          )
        )
      }
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selected || selected.scope === 'builtin' || !worktreeId) {
      return
    }
    const openTabs = useAppStore
      .getState()
      .openFiles.filter(
        (file) =>
          file.pipeline?.scope === selected.scope &&
          file.pipeline.ref === selected.ref &&
          (selected.scope === 'user' || file.pipeline.worktreeId === worktreeId)
      )
    const drafts = usePipelineCanvasDraftStore.getState().drafts
    if (openTabs.some((file) => file.isDirty || drafts[file.id]?.dirty)) {
      setError(
        translate(
          'fork.heimdallPipeline.menu.deleteOpenDirty',
          'Save or discard edits on the open canvas before deleting this pipeline.'
        )
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (selected.scope === 'repo') {
        await deleteRepoPipeline({ worktreeId, id: selected.id })
      } else {
        const source = await readPersonalPipeline({ id: selected.id })
        if (!source) {
          throw new Error(
            translate(
              'fork.heimdallPipeline.menu.pipelineMissing',
              'This pipeline no longer exists.'
            )
          )
        }
        const result = await deletePersonalPipeline(selected.id, source.personalSignature)
        if (result.status === 'conflict') {
          throw new Error(
            translate(
              'fork.heimdallPipeline.menu.deleteConflict',
              'This pipeline changed on disk. Reload the list and try again.'
            )
          )
        }
      }
      for (const file of openTabs) {
        useAppStore.getState().closeFile(file.id)
        disposeClosedPipelineTab(file.id)
      }
      setDeleteOpen(false)
      setOpen(false)
      setSelectedRef(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const reinclude = async (): Promise<void> => {
    if (!worktreeId || !trackingPipelineId) {
      return
    }
    const result = await ensurePipelineTracked(worktreeId, trackingPipelineId, true)
    setTracking(result)
    setReincludeAvailable(true)
  }

  return (
    <div className="contents">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={translate('fork.heimdallPipeline.menu.open', 'Pipelines')}
          >
            <MoreHorizontal aria-hidden="true" />
            {translate('fork.heimdallPipeline.menu.title', 'Pipelines')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>
            {translate('fork.heimdallPipeline.menu.listTitle', 'Pipelines')}
          </DropdownMenuLabel>
          <div className="max-h-56 overflow-y-auto scrollbar-sleek">
            {choices.map((choice) => (
              <DropdownMenuItem
                key={choice.ref}
                onSelect={(event) => {
                  event.preventDefault()
                  setSelectedRef(choice.ref)
                  setError(null)
                }}
                data-current={choice.ref === selectedRef ? 'true' : undefined}
              >
                {choice.ref === selectedRef ? (
                  <Check aria-hidden="true" />
                ) : (
                  <span className="size-4" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                {choice.scope === 'builtin' ? (
                  <Badge variant="secondary">
                    {translate('fork.heimdallPipeline.picker.builtin', 'Built-in')}
                  </Badge>
                ) : choice.scope === 'user' ? (
                  <Badge variant="outline">
                    {translate('fork.heimdallPipeline.picker.personal', 'Personal')}
                  </Badge>
                ) : null}
              </DropdownMenuItem>
            ))}
          </div>
          {loading ? (
            <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
              {translate('fork.heimdallPipeline.menu.loading', 'Loading pipelines…')}
            </p>
          ) : null}
          {error ? (
            <p className="px-2 py-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!selected || !worktreeId || busy} onSelect={openSelected}>
            {translate('fork.heimdallPipeline.menu.openSelected', 'Open')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!workspace || !worktreeId || busy}
            onSelect={() => void createNew()}
          >
            <GitBranchPlus aria-hidden="true" />
            {translate('fork.heimdallPipeline.menu.new', 'New pipeline')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selected || !workspace || !worktreeId || busy}
            onSelect={() => void copySelected('repo')}
          >
            {translate('fork.heimdallPipeline.menu.copyRepo', 'Copy to repo')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selected || !worktreeId || busy}
            onSelect={() => void copySelected('user')}
          >
            {translate('fork.heimdallPipeline.menu.copyPersonal', 'Copy to my pipelines')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selected || selected.scope === 'builtin' || !worktreeId || busy}
            onSelect={() => setDeleteOpen(true)}
          >
            {translate('fork.heimdallPipeline.menu.delete', 'Delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('fork.heimdallPipeline.menu.deleteTitle', 'Delete pipeline?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'fork.heimdallPipeline.menu.deleteDescription',
                'Delete {{name}} from {{scope}}. Existing runs keep their pinned version.',
                {
                  name: selected?.name ?? '',
                  scope:
                    selected?.scope === 'user'
                      ? translate('fork.heimdallPipeline.menu.scopePersonal', 'My pipelines')
                      : translate('fork.heimdallPipeline.menu.scopeRepo', 'this repo')
                }
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteOpen(false)}
            >
              {translate('fork.heimdallPipeline.menu.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void deleteSelected()}
            >
              {translate('fork.heimdallPipeline.menu.delete', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PipelineTrackingNotice
        result={tracking}
        reincludeAvailable={reincludeAvailable}
        onReinclude={() => void reinclude()}
        onDismiss={() => setTracking(null)}
      />
    </div>
  )
}
