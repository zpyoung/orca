import { isAbsolute as isPosixAbsolute } from 'node:path/posix'
import { isAbsolute as isWin32Absolute } from 'node:path/win32'
import { ipcMain } from 'electron'
import {
  parsePipelineTemplate,
  resolvePipelineDefinition,
  type PipelineTemplateError,
  type ResolvedPipelineDefinition
} from '../../shared/pipeline-template'
import {
  ensureStarterTemplate,
  getPipelineTemplatesDir,
  listPipelineTemplateFiles
} from '../pipelines/pipeline-template-files'

const TEMPLATE_EXTENSION_PATTERN = /\.(yaml|yml)$/

export type PipelineTemplateListEntry = {
  basename: string
  name: string
  description?: string
  needsNewerOrca: boolean
  error?: PipelineTemplateError
}

export type PipelineTemplateResolveResult =
  | { ok: true; definition: ResolvedPipelineDefinition }
  | {
      ok: false
      error:
        | { kind: 'invalid_basename' }
        | { kind: 'template_not_found' }
        | { kind: 'template_error'; detail: PipelineTemplateError }
    }

// untrusted renderer input: reject before it ever reaches the filesystem (§3.2 containment contract)
function isValidTemplateBasename(basename: string): boolean {
  if (basename.includes('/') || basename.includes('\\')) {
    return false
  }
  if (basename === '..' || basename === '.') {
    return false
  }
  if (isPosixAbsolute(basename) || isWin32Absolute(basename)) {
    return false
  }
  return TEMPLATE_EXTENSION_PATTERN.test(basename)
}

function listTemplateEntries(homePath: string): PipelineTemplateListEntry[] {
  const dir = getPipelineTemplatesDir(homePath)
  ensureStarterTemplate(dir)
  return listPipelineTemplateFiles(dir).map((file) => {
    const parsed = parsePipelineTemplate(file.content, file.basename)
    if (!parsed.ok) {
      return { basename: file.basename, name: file.basename, needsNewerOrca: false, error: parsed.error }
    }
    return {
      basename: file.basename,
      name: parsed.template.name,
      ...(parsed.template.description !== undefined
        ? { description: parsed.template.description }
        : {}),
      needsNewerOrca: parsed.template.needsNewerOrca
    }
  })
}

// re-enumerates the directory and matches by exact string equality only — never builds a
// path from the caller-supplied basename (§3.2 security contract)
function resolveTemplateByBasename(
  homePath: string,
  basename: string,
  inputText: string
): PipelineTemplateResolveResult {
  if (!isValidTemplateBasename(basename)) {
    return { ok: false, error: { kind: 'invalid_basename' } }
  }
  const dir = getPipelineTemplatesDir(homePath)
  const match = listPipelineTemplateFiles(dir).find((file) => file.basename === basename)
  if (!match) {
    return { ok: false, error: { kind: 'template_not_found' } }
  }
  const parsed = parsePipelineTemplate(match.content, match.basename)
  if (!parsed.ok) {
    return { ok: false, error: { kind: 'template_error', detail: parsed.error } }
  }
  return { ok: true, definition: resolvePipelineDefinition(parsed.template, inputText) }
}

// renderer IPC args cross a trust boundary and are erased to `unknown` at runtime by the
// time they reach here, regardless of the declared parameter type (§3.2 containment contract)
function isValidResolveTemplateArgs(
  args: unknown
): args is { basename: string; inputText: string } {
  if (typeof args !== 'object' || args === null) {
    return false
  }
  const { basename, inputText } = args as Record<string, unknown>
  return typeof basename === 'string' && typeof inputText === 'string'
}

function handleResolveTemplate(homePath: string, args: unknown): PipelineTemplateResolveResult {
  if (!isValidResolveTemplateArgs(args)) {
    return { ok: false, error: { kind: 'invalid_basename' } }
  }
  return resolveTemplateByBasename(homePath, args.basename, args.inputText)
}

let registered = false

// openMainWindow() can re-run on macOS 'activate'; ipcMain.handle() throws on re-registration
export function registerPipelineTemplateHandlers(homePath: string): void {
  if (registered) {
    return
  }
  registered = true

  ipcMain.handle('pipelines:list-templates', () => listTemplateEntries(homePath))
  ipcMain.handle('pipelines:resolve-template', (_event, args: unknown) =>
    handleResolveTemplate(homePath, args)
  )
}
