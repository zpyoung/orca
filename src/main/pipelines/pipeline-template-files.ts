import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { MAX_ORCA_YAML_BYTES } from '../../shared/orca-yaml-file-limit'
import { BUGFIX_FAST_STARTER_TEMPLATE } from './pipeline-starter-template'

const STARTER_TEMPLATE_BASENAME = 'bugfix-fast.yaml'

// a bare open() blocks indefinitely on a FIFO until a writer appears; O_NONBLOCK makes it
// return immediately so the fstat check below can reject a non-regular entry instead of
// hanging the process. The constant doesn't exist on Windows, but ordinary Windows
// directories can't contain FIFOs, so the plain read flag is correct there too.
const OPEN_FLAGS: number | string =
  process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK

export function getPipelineTemplatesDir(homePath: string): string {
  return join(homePath, '.orca', 'pipelines')
}

function isRealPathInsideDir(dirRealPath: string, candidateRealPath: string): boolean {
  const rel = relative(dirRealPath, candidateRealPath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// opens by name first, then confirms the open descriptor's identity (dev+ino) matches a
// freshly resolved, contained real path — applies to every entry, not just ones readdir
// classified as symlinks, and pins the read to the exact file that was validated even if
// the name is swapped afterward
function readTemplateFile(
  entryPath: string,
  dirRealPath: string,
  basename: string
): { path: string; basename: string; content: string } | undefined {
  let fd: number
  try {
    fd = openSync(entryPath, OPEN_FLAGS)
  } catch {
    return undefined
  }
  try {
    const openStats = fstatSync(fd)
    if (!openStats.isFile() || openStats.size > MAX_ORCA_YAML_BYTES) {
      return undefined
    }
    const currentRealPath = realpathSync(entryPath)
    if (!isRealPathInsideDir(dirRealPath, currentRealPath)) {
      return undefined
    }
    // lstat (not stat) so a real path that turned into a symlink after resolution reports
    // its own identity rather than silently following through to a new target
    const currentStats = lstatSync(currentRealPath)
    // an inode of 0 means the platform couldn't report real identity (seen on some Windows
    // filesystems) — treat that as indeterminate and reject rather than let a trivial
    // 0-equals-0 match through
    if (
      openStats.ino === 0 ||
      currentStats.ino === 0 ||
      currentStats.dev !== openStats.dev ||
      currentStats.ino !== openStats.ino
    ) {
      return undefined
    }
    return { path: entryPath, basename, content: readFileSync(fd, 'utf8') }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
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
    // liveness guard, not the security check: readdir's type bit rules out fifos and other
    // special files before anything opens them, since open() can block indefinitely on one.
    // It's a snapshot, so it doesn't replace readTemplateFile's fd-identity check below,
    // which still runs for every file and symlink entry that passes here.
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue
    }
    const file = readTemplateFile(join(dir, entry.name), dirRealPath, entry.name)
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
  try {
    // exclusive create refuses to follow anything already at this path — file, symlink, or
    // stale leftover — rather than writing through or replacing it; a single call means
    // there's no intermediate path for stale or hostile state to wedge
    writeFileSync(path, BUGFIX_FAST_STARTER_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
    return { created: true, path }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { created: false, path }
    }
    throw error
  }
}
