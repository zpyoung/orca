import { posix, win32 } from 'node:path'
import { parseLedgerImportSources } from './ledger-import-parser'
import { normalizeLedgerLocation } from '../../shared/ledger-locations'
import type {
  LedgerEntry,
  LedgerEvidence,
  LedgerImportRecord,
  LedgerImportSkip,
  LedgerLocation,
  LedgerOrigin
} from '../../shared/ledger'

export type LedgerHostWorkspace = {
  workspaceId: string
  rootPath: string
  host: string
  platform: 'win32' | 'posix'
  projectId?: string
  branch?: string
  isGit: boolean
}

export type LedgerHostIo = {
  readFile(path: string): Promise<string>
  listDirectory(path: string): Promise<{ name: string; isDirectory: boolean }[]>
  observeRevision(): Promise<string | null>
}

type HostLocationContext = {
  base: { kind: 'project' | 'workspace'; id: string; host?: string }
  rootPath: string
  platform: LedgerHostWorkspace['platform']
  host: string
}

const optionalSourceNames = ['BUGS.md', 'DEFERRED.md', 'TEST_BACKLOG.md', 'proposals.md']

function pathApi(platform: LedgerHostWorkspace['platform']): typeof posix {
  return platform === 'win32' ? (win32 as unknown as typeof posix) : posix
}

function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function sourceBase(workspace: LedgerHostWorkspace) {
  return workspace.projectId
    ? { kind: 'project' as const, id: workspace.projectId, host: workspace.host }
    : { kind: 'workspace' as const, id: workspace.workspaceId, host: workspace.host }
}

function sourcePath(workspace: LedgerHostWorkspace, relative: string): string {
  return pathApi(workspace.platform).join(workspace.rootPath, ...relative.split('/'))
}

/** Read the documented checkout sources; host callbacks own all actual IO. */
export async function collectLedgerImportSources(
  workspace: LedgerHostWorkspace,
  io: LedgerHostIo
): Promise<{ records: LedgerImportRecord[]; skipped: LedgerImportSkip[] }> {
  const base = sourceBase(workspace)
  const skipped: LedgerImportSkip[] = []
  const sources: { path: string; content: string }[] = []

  for (const relative of optionalSourceNames) {
    try {
      sources.push({ path: relative, content: await io.readFile(sourcePath(workspace, relative)) })
    } catch (error) {
      if (!isMissing(error)) {
        skipped.push({ sourcePath: relative, reason: readError(error) })
      }
    }
  }

  const adrDirectory = 'docs/adr'
  try {
    const entries = await io.listDirectory(sourcePath(workspace, adrDirectory))
    for (const entry of entries) {
      if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.md')) {
        continue
      }
      const relative = `${adrDirectory}/${entry.name}`
      try {
        sources.push({
          path: relative,
          content: await io.readFile(sourcePath(workspace, relative))
        })
      } catch (error) {
        if (!isMissing(error)) {
          skipped.push({ sourcePath: relative, reason: readError(error) })
        }
      }
    }
  } catch (error) {
    if (!isMissing(error)) {
      skipped.push({ sourcePath: adrDirectory, reason: readError(error) })
    }
  }

  const parsed = parseLedgerImportSources(sources, base)
  const context: HostLocationContext = {
    base,
    rootPath: workspace.rootPath,
    platform: workspace.platform,
    host: workspace.host
  }
  const records: LedgerImportRecord[] = []
  for (const record of parsed.records) {
    try {
      records.push({ ...record, content: normalizeImportedContent(record, context) })
    } catch (error) {
      skipped.push({
        anchor: record.anchor,
        sourcePath: record.sourcePath,
        reason: readError(error)
      })
    }
  }
  return { records, skipped: [...parsed.skipped, ...skipped] }
}

function normalizeImportedContent(
  record: LedgerImportRecord,
  context: HostLocationContext
): Record<string, unknown> {
  const content = { ...record.content }
  for (const key of ['file', 'file_under_test']) {
    const value = content[key]
    if (typeof value === 'string' || isLocation(value)) {
      content[key] = normalizeLedgerLocation(value, context)
    }
  }
  return content
}

function isLocation(value: unknown): value is LedgerLocation {
  return (
    !!value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string'
  )
}

function readError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `unable to read source: ${error.message}`
  }
  return 'unable to read source'
}

export async function observeLedgerOrigin(
  workspace: LedgerHostWorkspace,
  io: LedgerHostIo
): Promise<LedgerOrigin> {
  let revision: string | null = null
  if (workspace.isGit) {
    try {
      revision = await io.observeRevision()
    } catch {
      revision = null
    }
  }
  return {
    workspaceId: workspace.workspaceId,
    ...(workspace.projectId
      ? { owner: { tier: 'project' as const, id: workspace.projectId } }
      : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    host: workspace.host,
    ...(revision ? { revision } : {})
  }
}

type ExtendedLedgerEvidence = LedgerEvidence & {
  observedAt?: string
  baselineRevision?: string
  fileExists?: boolean
}

export async function collectLedgerReviewEvidence(
  entry: LedgerEntry,
  resolve: (
    workspaceId: string
  ) => Promise<{ workspace: LedgerHostWorkspace; io: LedgerHostIo } | null>
): Promise<LedgerEvidence> {
  const workspaceId = entry.origin.workspaceId
  if (!workspaceId) {
    return unavailableEvidence('No originating workspace is recorded')
  }
  const resolved = await resolve(workspaceId)
  if (!resolved) {
    return unavailableEvidence('Originating workspace is unavailable', workspaceId)
  }

  const { workspace, io } = resolved
  const location = entry.content.file ?? entry.content.file_under_test
  let observedRevision: string | null = null
  let revisionError = false
  if (workspace.isGit) {
    try {
      observedRevision = await io.observeRevision()
    } catch {
      revisionError = true
    }
  }
  const observedAt = new Date().toISOString()
  const baselineRevision = entry.origin.revision
  if (revisionError) {
    return evidence({
      available: false,
      workspaceId,
      observedAt,
      baselineRevision,
      note: 'Current revision is unavailable'
    })
  }
  if (!isLocation(location)) {
    return evidence({
      available: observedRevision !== null || !workspace.isGit,
      workspaceId,
      observedRevision: observedRevision ?? undefined,
      observedAt,
      baselineRevision,
      note:
        workspace.isGit && observedRevision === null
          ? 'Current revision is unavailable'
          : 'Entry has no repository location'
    })
  }
  if (location.external) {
    return evidence({
      available: false,
      workspaceId,
      observedAt,
      baselineRevision,
      note: 'External locations are not dereferenced during review'
    })
  }
  if (!locationBelongsToWorkspace(location, workspace)) {
    return evidence({
      available: false,
      workspaceId,
      observedAt,
      baselineRevision,
      note: 'Recorded location is outside this workspace scope'
    })
  }

  const path = sourcePath(workspace, location.path)
  try {
    await io.readFile(path)
    return evidence({
      available: true,
      workspaceId,
      observedRevision: observedRevision ?? undefined,
      observedAt,
      baselineRevision,
      fileExists: true,
      note: comparableNote(baselineRevision, observedRevision)
    })
  } catch (error) {
    if (isMissing(error)) {
      return evidence({
        available: true,
        workspaceId,
        observedRevision: observedRevision ?? undefined,
        observedAt,
        baselineRevision,
        fileExists: false,
        note: comparableNote(baselineRevision, observedRevision, 'Recorded file is absent')
      })
    }
    return evidence({
      available: false,
      workspaceId,
      observedAt,
      baselineRevision,
      note: `Current file evidence is unavailable: ${readError(error)}`
    })
  }
}

function locationBelongsToWorkspace(
  location: LedgerLocation,
  workspace: LedgerHostWorkspace
): boolean {
  if (location.base.kind === 'workspace') {
    return location.base.id === workspace.workspaceId
  }
  return location.base.kind === 'project' && location.base.id === workspace.projectId
}

function comparableNote(
  baseline: string | undefined,
  observed: string | null,
  prefix?: string
): string {
  const status = prefix ? `${prefix}; ` : ''
  if (!baseline || !observed) {
    return `${status}baseline comparison unavailable`
  }
  return `${status}baseline and current revisions recorded; file presence alone does not establish resolution`
}

function evidence(value: ExtendedLedgerEvidence): LedgerEvidence {
  return value as LedgerEvidence
}

function unavailableEvidence(note: string, workspaceId?: string): LedgerEvidence {
  return evidence({
    available: false,
    ...(workspaceId ? { workspaceId } : {}),
    observedAt: new Date().toISOString(),
    note
  })
}
