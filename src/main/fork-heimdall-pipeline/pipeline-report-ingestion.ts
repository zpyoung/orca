import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type {
  PipelineAgentNode,
  PipelineOutputType
} from '../../shared/fork-heimdall-pipeline/document-schema'
import { TaskListSchema } from '../../shared/fork-heimdall-pipeline/task-list'
import { readHardenedReportBytes } from '../fork-heimdall/hardened-report-file-reader'
import { requireRuntimeFileProvider } from '../runtime/runtime-file-command-target'
import {
  issuePipelineReportPath,
  MAX_PIPELINE_REPORT_BYTES,
  pipelineReportAuthorityRoot,
  type PipelineWorkspaceTarget
} from './pipeline-report-path'

const AgentReportSchema = z
  .object({
    nodeId: z.string(),
    summary: z.string().max(4_000),
    outputs: z.record(z.string(), z.unknown())
  })
  .strict()
const VerdictOutputSchema = z
  .object({
    verdict: z.enum(['approve', 'revise', 'escalate']),
    reason: z.string().max(4_000).optional(),
    objections: z.array(z.string()).max(50).optional()
  })
  .strict()

export type PipelineAgentReport = z.infer<typeof AgentReportSchema>

export type PipelineReportValidation =
  | { ok: true; report: PipelineAgentReport }
  | { ok: false; error: string }

export type PipelineReportReadResult =
  | { status: 'read'; bytes: Buffer }
  | { status: 'missing' }
  | { status: 'unverifiable'; reason: string }

export type PipelineReportReadTarget = Readonly<
  PipelineWorkspaceTarget & { attemptFingerprint: string }
>

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  if (typeof value !== 'object') {
    return false
  }
  return Object.values(value).every(isJsonValue)
}

function safeWorktreeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false
  }
  return !value.split(/[\\/]/u).some((segment) => segment === '..' || segment === '.')
}

function outputValueIssue(name: string, type: PipelineOutputType, value: unknown): string | null {
  switch (type.type) {
    case 'text':
      return typeof value === 'string' ? null : `outputs.${name}: expected a string.`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `outputs.${name}: expected a finite number.`
    case 'boolean':
      return typeof value === 'boolean' ? null : `outputs.${name}: expected a boolean.`
    case 'json':
      return isJsonValue(value) ? null : `outputs.${name}: expected a JSON value.`
    case 'file':
      if (typeof value !== 'string' || !safeWorktreeRelativePath(value)) {
        return `outputs.${name}: expected a worktree-relative file path.`
      }
      return null
    case 'taskList': {
      const parsed = TaskListSchema.safeParse(value)
      return parsed.success ? null : `outputs.${name}: ${parsed.error.message}`
    }
    case 'verdict': {
      const parsed = VerdictOutputSchema.safeParse(value)
      return parsed.success ? null : `outputs.${name}: ${parsed.error.message}`
    }
    case 'enum':
      return typeof value === 'string' && type.values.includes(value)
        ? null
        : `outputs.${name}: expected one of ${JSON.stringify(type.values)}.`
  }
}

/** Validates the Agent JSON report against one declared node and its live file workspace. */
export async function validatePipelineReport(
  raw: unknown,
  node: Pick<PipelineAgentNode, 'id' | 'outputs'>,
  fileExists: (relPath: string) => Promise<boolean>
): Promise<PipelineReportValidation> {
  const parsed = AgentReportSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message }
  }
  const report = parsed.data
  if (report.nodeId !== node.id) {
    return { ok: false, error: `report.nodeId: expected ${JSON.stringify(node.id)}.` }
  }
  const declared = node.outputs ?? {}
  const outputNames = Object.keys(report.outputs)
  const declaredNames = Object.keys(declared)
  const extraOutput = outputNames.filter((name) => !Object.hasOwn(declared, name)).sort()[0]
  if (extraOutput !== undefined) {
    return { ok: false, error: `report.outputs: undeclared key ${JSON.stringify(extraOutput)}.` }
  }
  const missingOutput = declaredNames
    .filter((name) => !Object.hasOwn(report.outputs, name))
    .sort()[0]
  if (missingOutput !== undefined) {
    return {
      ok: false,
      error: `report.outputs: missing declared key ${JSON.stringify(missingOutput)}.`
    }
  }
  for (const [name, outputType] of Object.entries(declared).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const value = report.outputs[name]
    const issue = outputValueIssue(name, outputType, value)
    if (issue !== null) {
      return { ok: false, error: issue }
    }
    if (outputType.type === 'file') {
      if (typeof value !== 'string') {
        return { ok: false, error: `outputs.${name}: expected a worktree-relative file path.` }
      }
      if (!(await fileExists(value))) {
        return {
          ok: false,
          error: `outputs.${name}: file does not exist: ${JSON.stringify(value)}.`
        }
      }
    }
  }
  return { ok: true, report }
}

/** Reads only the exact report path issued for this fingerprint using the hardened host reader. */
export async function readPipelineReport(
  reportPath: string,
  target: PipelineReportReadTarget
): Promise<PipelineReportReadResult> {
  let expectedPath: string
  try {
    expectedPath = issuePipelineReportPath(target, target.attemptFingerprint)
  } catch (error) {
    return {
      status: 'unverifiable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (reportPath !== expectedPath) {
    return { status: 'unverifiable', reason: 'path-mismatch' }
  }
  try {
    const fileProvider = requireRuntimeFileProvider(target)
    const read = await readHardenedReportBytes({
      executionHostId: target.executionHostId,
      fileProvider,
      reportPath: expectedPath,
      authorityRoot: pipelineReportAuthorityRoot(target),
      maxBytes: MAX_PIPELINE_REPORT_BYTES
    })
    if ('ok' in read) {
      return read.reason === 'missing'
        ? { status: 'missing' }
        : { status: 'unverifiable', reason: read.reason }
    }
    return { status: 'read', bytes: read.buffer }
  } catch (error) {
    return {
      status: 'unverifiable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}
