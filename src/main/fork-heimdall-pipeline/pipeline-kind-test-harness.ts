import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DispatchWorkerInput } from '../../shared/fork-heimdall/kind-contract'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { EnrollInput, EnrollResult } from '../../shared/fork-heimdall/watcher-types'
import { createPipelineKindLedgerFixture } from './pipeline-kind-ledger-fixtures'
import type {
  PipelineKindLedgerFixture,
  PipelineKindLedgerOptions
} from './pipeline-kind-ledger-fixtures'
import { createPipelineKindWorkspaceFixture } from './pipeline-kind-workspace-fixtures'
import type {
  PipelineKindWorkspaceFixture,
  PipelineKindWorkspaceOptions
} from './pipeline-kind-workspace-fixtures'

export const PIPELINE_AGENT_SOURCE = `version: 1
id: bugfix
name: Bugfix
inputs:
  task:
    type: text
    required: true
nodes:
  - id: fix
    type: agent
    harness: claude
    prompt: "Fix the reported bug: $run.inputs.task"
    outputs:
      summary:
        type: text
`

export const PIPELINE_GATE_SOURCE = `version: 1
id: approval-flow
name: Approval flow
inputs:
  task:
    type: text
    required: true
nodes:
  - id: approval
    type: gate
    label: Review the result
`

export const PIPELINE_SCRIPT_SOURCE = `version: 1
id: script-flow
name: Script flow
inputs:
  task:
    type: text
    required: true
nodes:
  - id: notify
    type: script
    capability: script
    command: printf '%s' "$VALUE"
    inputs:
      VALUE: $run.inputs.task
`

export type PipelineKindHarnessOptions = PipelineKindWorkspaceOptions & PipelineKindLedgerOptions
export type PipelineEnrollmentInputOptions = Readonly<{
  capabilities?: Record<string, 'off' | 'gated' | 'on'>
  runInputs?: Record<string, string | number | boolean>
  pin?: PipelinePin
  worktreeId?: string | null
  newWorktree?: { name: string; baseBranch?: string }
  repoId?: string
}>

type PipelineWorkspaceAuthority = Pick<
  PipelineKindWorkspaceFixture,
  'repoId' | 'worktreeId' | 'workspaceKind'
>

export type PipelineKindTestHarness = PipelineKindWorkspaceFixture &
  Omit<PipelineKindLedgerFixture, 'enroll' | 'close'> &
  Readonly<{
    enroll(sourceText?: string, options?: PipelineEnrollmentInputOptions): Promise<EnrollResult>
    close(): Promise<void>
  }>

export function pipelineEnrollmentInput(
  workspace: PipelineWorkspaceAuthority,
  sourceText = PIPELINE_AGENT_SOURCE,
  options: PipelineEnrollmentInputOptions = {}
): EnrollInput {
  const parsed = parsePipelineText(sourceText)
  if (parsed.document === null) {
    throw new Error(
      `Test pipeline source did not parse: ${parsed.errors.map((error) => error.message).join('; ')}`
    )
  }
  const document = parsed.document
  const pin = options.pin ?? {
    ref: document.id,
    scope: 'repo',
    id: document.id,
    contentHash: pipelineContentHash(document),
    documentVersion: document.version
  }
  const kindPayload = {
    schemaVersion: 1,
    pin,
    document,
    sourceText,
    runInputs: options.runInputs ?? { task: 'fix the null handling bug' },
    workspaceKind: workspace.workspaceKind,
    ...(options.newWorktree === undefined ? {} : { newWorktree: options.newWorktree })
  }
  return {
    kind: 'pipeline',
    repoId: options.repoId ?? workspace.repoId,
    worktreeId: options.worktreeId === undefined ? workspace.worktreeId : options.worktreeId,
    capabilities: options.capabilities ?? {
      agent: 'on',
      check: 'on',
      script: 'on',
      integrate: 'on',
      push: 'off',
      land: 'off'
    },
    budget: { wallClockActiveMs: 60_000, turns: 8 },
    kindPayload
  }
}

function reportPathFromTaskSpec(spec: string): string {
  const prefix = 'Write the strict JSON report atomically to this exact absolute path: '
  const line = spec.split('\n').find((candidate) => candidate.startsWith(prefix))
  if (line === undefined) {
    throw new Error('Pipeline Agent dispatch omitted its exact report path instruction')
  }
  const parsed: unknown = JSON.parse(line.slice(prefix.length))
  if (typeof parsed !== 'string' || !isAbsolute(parsed)) {
    throw new Error('Pipeline Agent report instruction did not contain an absolute path')
  }
  return parsed
}

export async function createPipelineKindTestHarness(
  options: PipelineKindHarnessOptions = {}
): Promise<PipelineKindTestHarness> {
  const workspace = await createPipelineKindWorkspaceFixture(options)
  let ledger: PipelineKindLedgerFixture | null = null
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    try {
      await ledger?.close()
    } finally {
      await rm(workspace.root, { recursive: true, force: true })
    }
  }
  try {
    ledger = await createPipelineKindLedgerFixture(workspace, options)
    return {
      ...workspace,
      ...ledger,
      async enroll(sourceText = PIPELINE_AGENT_SOURCE, enrollmentOptions = {}) {
        return await ledger!.enroll(
          pipelineEnrollmentInput(workspace, sourceText, enrollmentOptions)
        )
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}

export function pipelineReportPathFromDispatch(input: DispatchWorkerInput): string {
  return reportPathFromTaskSpec(input.spec)
}
