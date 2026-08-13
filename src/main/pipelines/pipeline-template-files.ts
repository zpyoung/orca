import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
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

// opens once and checks/reads through that one fd, so nothing can swap the target between
// the validation and the read
function readTemplateFile(
  readPath: string,
  reportedPath: string,
  basename: string
): { path: string; basename: string; content: string } | undefined {
  let fd: number
  try {
    fd = openSync(readPath, 'r')
  } catch {
    return undefined
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > MAX_ORCA_YAML_BYTES) {
      return undefined
    }
    return { path: reportedPath, basename, content: readFileSync(fd, 'utf8') }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

function resolveContainedSymlink(entryPath: string, dirRealPath: string): string | undefined {
  let targetRealPath: string
  try {
    targetRealPath = realpathSync(entryPath)
  } catch {
    return undefined
  }
  return isRealPathInsideDir(dirRealPath, targetRealPath) ? targetRealPath : undefined
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
    let readPath = entryPath
    if (entry.isSymbolicLink()) {
      const resolved = resolveContainedSymlink(entryPath, dirRealPath)
      if (!resolved) {
        continue
      }
      readPath = resolved
    } else if (!entry.isFile()) {
      continue
    }
    const file = readTemplateFile(readPath, entryPath, entry.name)
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
  mkdirSync(dir, { recursive: true })
  const tempPath = join(dir, `${STARTER_TEMPLATE_BASENAME}.tmp`)
  // exclusive create refuses to follow anything already at the temp path — including a
  // symlink planted at this predictable name — instead of writing through it
  writeFileSync(tempPath, BUGFIX_FAST_STARTER_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
  try {
    // a hard link fails with EEXIST rather than replacing an existing destination, so
    // create-if-absent is a single atomic step instead of a check followed by a write
    linkSync(tempPath, path)
    return { created: true, path }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { created: false, path }
    }
    throw error
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {}
  }
}
