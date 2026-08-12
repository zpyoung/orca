import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { MAX_ORCA_YAML_BYTES } from '../../shared/orca-yaml-file-limit'
import { BUGFIX_FAST_STARTER_TEMPLATE } from './pipeline-starter-template'

const STARTER_TEMPLATE_BASENAME = 'bugfix-fast.yaml'

export function getPipelineTemplatesDir(homePath: string): string {
  return join(homePath, '.orca', 'pipelines')
}

function isRealPathInsideDir(dirRealPath: string, candidateRealPath: string): boolean {
  const rel = relative(dirRealPath, candidateRealPath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function readTemplateFile(
  path: string,
  basename: string
): { path: string; basename: string; content: string } | undefined {
  try {
    if (statSync(path).size > MAX_ORCA_YAML_BYTES) {
      return undefined
    }
    return { path, basename, content: readFileSync(path, 'utf8') }
  } catch {
    return undefined
  }
}

function resolveContainedSymlink(entryPath: string, dirRealPath: string): string | undefined {
  let targetRealPath: string
  try {
    targetRealPath = realpathSync(entryPath)
  } catch {
    return undefined
  }
  if (!isRealPathInsideDir(dirRealPath, targetRealPath)) {
    return undefined
  }
  try {
    if (!statSync(targetRealPath).isFile()) {
      return undefined
    }
  } catch {
    return undefined
  }
  return targetRealPath
}

/**
 * Enumerates regular files directly inside `dir` — no recursion. A symlink whose resolved
 * real path falls outside `dir` (escape) or is broken is skipped rather than followed.
 */
export function listPipelineTemplateFiles(
  dir: string
): { path: string; basename: string; content: string }[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  let dirRealPath: string
  try {
    dirRealPath = realpathSync(dir)
  } catch {
    return []
  }

  const files: { path: string; basename: string; content: string }[] = []
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      if (!resolveContainedSymlink(entryPath, dirRealPath)) {
        continue
      }
    } else if (!entry.isFile()) {
      continue
    }
    const file = readTemplateFile(entryPath, entry.name)
    if (file) {
      files.push(file)
    }
  }
  return files
}

/**
 * Provisions the shipped `bugfix-fast` starter on first use (T2). Never overwrites a file
 * already at that name — mirrors `ensureKeybindingFile`'s never-replace-a-user-file
 * invariant (`keybinding-file.ts:393-396`).
 */
export function ensureStarterTemplate(dir: string): { created: boolean; path: string } {
  const path = join(dir, STARTER_TEMPLATE_BASENAME)
  if (existsSync(path)) {
    return { created: false, path }
  }

  mkdirSync(dir, { recursive: true })
  const tempPath = `${path}.tmp`
  try {
    writeFileSync(tempPath, BUGFIX_FAST_STARTER_TEMPLATE, 'utf8')
    renameSync(tempPath, path)
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // best-effort cleanup; the original write error is more actionable
    }
    throw error
  }
  return { created: true, path }
}
