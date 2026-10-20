import { useEffect, useId, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { BUILTIN_PIPELINE_TEXTS } from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  validatePipeline,
  type PipelineValidationError
} from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { PipelineListResponse } from '../../../shared/fork-heimdall-pipeline/rpc-schemas'
import { getObjectiveHeimdallApi } from '../fork-heimdall-objective/objective-heimdall-api'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { listPersonalPipelines, readPersonalPipeline } from './pipeline-file-io'
import { openPipelineTab } from './open-pipeline-tab'

export type PipelinePickerChoice = PipelineListResponse['pipelines'][number]
export type LoadedPipelineSelection = PipelinePickerChoice & {
  sourceText: string
  document: PipelineDocument | null
  validationErrors: readonly PipelineValidationError[]
}

type PipelineWorkspace = Pick<ObjectiveWorkspaceOption, 'repoId' | 'worktreeId' | 'workspaceKind'>

function makeChoice(input: {
  ref: string
  scope: PipelinePickerChoice['scope']
  id: string
  name: string
  sourceText: string
  workspaceKind: PipelineWorkspace['workspaceKind'] | null
  liveRuns?: PipelinePickerChoice['liveRuns']
}): LoadedPipelineSelection {
  const parsed = parsePipelineText(input.sourceText)
  const validationErrors =
    parsed.document === null
      ? parsed.errors
      : input.workspaceKind === null
        ? []
        : validatePipeline(parsed.document, {
            workspaceKind: input.workspaceKind,
            expectedId: input.id
          })
  const document = parsed.document
  return {
    ref: input.ref,
    scope: input.scope,
    id: input.id,
    name: document?.name ?? input.name,
    valid: document !== null && validationErrors.length === 0,
    errorCount: validationErrors.length,
    contentHash: document === null ? null : pipelineContentHash(document),
    liveRuns: input.liveRuns ?? [],
    sourceText: input.sourceText,
    document,
    validationErrors
  }
}

function builtInChoices(
  workspaceKind: PipelineWorkspace['workspaceKind'] | null
): LoadedPipelineSelection[] {
  return Object.entries(BUILTIN_PIPELINE_TEXTS).map(([id, sourceText]) =>
    makeChoice({
      ref: `builtin:${id}`,
      scope: 'builtin',
      id,
      name: id === 'objective' ? 'Objective' : 'PR sitter',
      sourceText,
      workspaceKind
    })
  )
}

/** Repo choices are resolved by the workspace owner; profile bytes always use the local client RPC. */
export async function listPipelineChoices(
  workspace: PipelineWorkspace | null
): Promise<{ choices: PipelinePickerChoice[]; error: string | null }> {
  const workspaceKind = workspace?.workspaceKind ?? null
  const errors: string[] = []
  let workspaceChoices: PipelinePickerChoice[] = builtInChoices(workspaceKind)
  if (workspace) {
    try {
      const api = getObjectiveHeimdallApi()
      if (typeof api?.pipelineList !== 'function') {
        throw new Error(
          translate(
            'fork.heimdallPipeline.error.repositoryUnavailable',
            'Repository pipeline service is unavailable on this host.'
          )
        )
      }
      const response = await api.pipelineList({
        workspace: { repoId: workspace.repoId, worktreeId: workspace.worktreeId }
      })
      workspaceChoices = response.pipelines.filter((pipeline) => pipeline.scope !== 'user')
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause))
    }
  }

  let personal: { id: string; name: string }[] = []
  try {
    personal = await listPersonalPipelines()
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause))
  }
  const personalChoices = await Promise.all(
    personal.map(async ({ id, name }) => {
      try {
        const source = await readPersonalPipeline({ id })
        const choice = makeChoice({
          ref: `user:${id}`,
          scope: 'user',
          id,
          name,
          sourceText: source?.yamlText ?? '',
          workspaceKind
        })
        return {
          ref: choice.ref,
          scope: choice.scope,
          id: choice.id,
          name: choice.name,
          valid: choice.valid,
          errorCount: choice.errorCount,
          contentHash: choice.contentHash,
          liveRuns: []
        }
      } catch (cause) {
        errors.push(cause instanceof Error ? cause.message : String(cause))
        return {
          ref: `user:${id}`,
          scope: 'user' as const,
          id,
          name,
          valid: false,
          errorCount: 1,
          contentHash: null,
          liveRuns: []
        }
      }
    })
  )
  return {
    choices: [...workspaceChoices, ...personalChoices],
    error: errors.length === 0 ? null : errors.join('\n')
  }
}

function builtinSourceText(id: string): string | null {
  if (id === 'objective' || id === 'pr-sitter') {
    return BUILTIN_PIPELINE_TEXTS[id]
  }
  return null
}

async function loadSelectedPipeline(
  choice: PipelinePickerChoice,
  workspace: PipelineWorkspace | null
): Promise<LoadedPipelineSelection> {
  if (choice.scope === 'builtin') {
    const sourceText = builtinSourceText(choice.id)
    if (sourceText === null) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.builtinMissing',
          'This built-in pipeline {{id}} is unavailable.',
          { id: choice.id }
        )
      )
    }
    return makeChoice({ ...choice, sourceText, workspaceKind: workspace?.workspaceKind ?? null })
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
    return makeChoice({
      ...choice,
      sourceText: source.yamlText,
      workspaceKind: workspace?.workspaceKind ?? null
    })
  }
  if (!workspace) {
    throw new Error(
      translate(
        'fork.heimdallObjective.validation.workspaceRequired',
        'Choose a workspace to load repository pipelines.'
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
  const resolved = await api.pipelineResolve({
    workspace: { repoId: workspace.repoId, worktreeId: workspace.worktreeId },
    ref: choice.ref
  })
  if (resolved.scope !== 'repo' || resolved.id !== choice.id || resolved.ref !== choice.ref) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.sourceMismatch',
        'Repository pipeline {{id}} resolved to a different source.',
        { id: choice.id }
      )
    )
  }
  const selected = makeChoice({
    ...choice,
    sourceText: resolved.sourceText,
    workspaceKind: workspace.workspaceKind
  })
  return resolved.errors.length > 0
    ? {
        ...selected,
        valid: false,
        errorCount: resolved.errors.length,
        validationErrors: resolved.errors
      }
    : selected
}

export type PipelinePickerProps = {
  workspace: ObjectiveWorkspaceOption | null
  worktreeId: string | null
  initialRef?: string
  onSelectionChange: (selection: LoadedPipelineSelection | null) => void
}

export function PipelinePicker({
  workspace,
  worktreeId,
  initialRef,
  onSelectionChange
}: PipelinePickerProps): React.JSX.Element {
  const requestedInitialRef = initialRef ?? 'builtin:objective'
  const labelId = useId()
  const [choices, setChoices] = useState<PipelinePickerChoice[]>([])
  const [selectedRef, setSelectedRef] = useState(requestedInitialRef)
  const [selection, setSelection] = useState<LoadedPipelineSelection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)
  const selectionGeneration = useRef(0)
  const selectedRefRef = useRef(requestedInitialRef)
  const workspaceRepoId = workspace?.repoId ?? null
  const workspaceWorktreeId = workspace?.worktreeId ?? null
  const workspaceKind = workspace?.workspaceKind ?? null
  const workspaceScope = workspace
    ? {
        repoId: workspace.repoId,
        worktreeId: workspace.worktreeId,
        workspaceKind: workspace.workspaceKind
      }
    : null

  useEffect(() => {
    let cancelled = false
    selectionGeneration.current += 1
    const scope: PipelineWorkspace | null =
      workspaceRepoId === null || workspaceKind === null
        ? null
        : {
            repoId: workspaceRepoId,
            worktreeId: workspaceWorktreeId,
            workspaceKind
          }
    setLoading(true)
    setError(null)
    setListingError(null)
    setSelection(null)
    onSelectionChange(null)
    void listPipelineChoices(scope)
      .then((listing) => {
        if (cancelled) {
          return
        }
        const nextChoices = listing.choices
        setListingError(listing.error)
        if (cancelled) {
          return
        }
        setChoices(nextChoices)
        const requested = nextChoices.find((choice) => choice.ref === selectedRefRef.current)
        const pendingRepoRef =
          scope === null &&
          !selectedRefRef.current.startsWith('builtin:') &&
          !selectedRefRef.current.startsWith('user:') &&
          requested === undefined
        if (pendingRepoRef) {
          setSelectedRef(selectedRefRef.current)
          return undefined
        }
        if (!requested) {
          selectedRefRef.current = ''
          setSelectedRef('')
          setError(
            translate(
              'fork.heimdallPipeline.picker.sourceMissing',
              'The selected pipeline is no longer available in this scope.'
            )
          )
          return undefined
        }
        const generation = ++selectionGeneration.current
        return loadSelectedPipeline(requested, scope).then((loaded) => {
          if (!cancelled && selectionGeneration.current === generation) {
            setSelection(loaded)
            onSelectionChange(loaded)
          }
        })
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
      selectionGeneration.current += 1
    }
  }, [onSelectionChange, workspaceRepoId, workspaceWorktreeId, workspaceKind])

  const choose = (ref: string): void => {
    selectedRefRef.current = ref
    setSelectedRef(ref)
    setError(null)
    setSelection(null)
    onSelectionChange(null)
    const choice = choices.find((candidate) => candidate.ref === ref)
    if (!choice) {
      setSelection(null)
      onSelectionChange(null)
      return
    }
    const generation = ++selectionGeneration.current
    setLoading(true)
    void loadSelectedPipeline(choice, workspaceScope)
      .then((loaded) => {
        if (selectionGeneration.current === generation) {
          setSelection(loaded)
          onSelectionChange(loaded)
        }
      })
      .catch((cause: unknown) => {
        if (selectionGeneration.current === generation) {
          setSelection(null)
          onSelectionChange(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (selectionGeneration.current === generation) {
          setLoading(false)
        }
      })
  }

  const openOnCanvas = (): void => {
    if (!selection || !worktreeId) {
      return
    }
    const opened = openPipelineTab({ scope: selection.scope, worktreeId, id: selection.id })
    if (!opened) {
      setError(
        translate(
          'fork.heimdallPipeline.picker.workspaceUnavailable',
          'The workspace could not be opened.'
        )
      )
    }
  }

  return (
    <section
      className="space-y-2"
      aria-label={translate('fork.heimdallPipeline.picker.title', 'Pipeline')}
    >
      <div className="space-y-1">
        <Label id={labelId}>{translate('fork.heimdallPipeline.picker.label', 'Pipeline')}</Label>
        <Select value={selectedRef} onValueChange={choose} disabled={loading}>
          <SelectTrigger aria-labelledby={labelId}>
            <SelectValue
              placeholder={translate(
                'fork.heimdallPipeline.picker.placeholder',
                'Choose a pipeline'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.ref} value={choice.ref}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{choice.name}</span>
                  {choice.scope === 'builtin' ? (
                    <Badge variant="secondary">
                      {translate('fork.heimdallPipeline.picker.builtin', 'Built-in')}
                    </Badge>
                  ) : choice.scope === 'user' ? (
                    <Badge variant="outline">
                      {translate('fork.heimdallPipeline.picker.personal', 'Personal')}
                    </Badge>
                  ) : null}
                  {!choice.valid ? (
                    <Badge variant="destructive">
                      {translate('fork.heimdallPipeline.picker.invalid', 'Invalid')}
                    </Badge>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {selection?.scope === 'builtin' ? (
          <Badge variant="secondary">
            {translate('fork.heimdallPipeline.picker.builtin', 'Built-in')}
          </Badge>
        ) : selection?.scope === 'user' ? (
          <Badge variant="outline">
            {translate('fork.heimdallPipeline.picker.personal', 'Personal')}
          </Badge>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!selection || !worktreeId}
          onClick={openOnCanvas}
        >
          {translate('fork.heimdallPipeline.picker.openCanvas', 'Open on canvas')}
        </Button>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          {translate('fork.heimdallPipeline.picker.loading', 'Loading pipelines…')}
        </p>
      ) : null}
      {listingError ? (
        <p className="text-xs text-destructive" role="alert">
          {listingError}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {selection && !selection.valid ? (
        <div className="space-y-1 text-xs text-destructive" role="alert">
          {selection.validationErrors.map((validationError) => (
            <p key={JSON.stringify(validationError)}>
              {validationError.nodeId ?? '-'} {validationError.code}: {validationError.message}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  )
}
