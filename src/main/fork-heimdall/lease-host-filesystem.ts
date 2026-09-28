import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { getSshTargetIdForExecutionHost, type ExecutionHostId } from '../../shared/execution-host'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import type { IFilesystemProvider } from '../providers/types'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'

export type LeaseHostFilesystem = Pick<
  IFilesystemProvider,
  'readDir' | 'readFile' | 'writeFile' | 'rename' | 'stat' | 'createDir' | 'createDirNoClobber'
>

export type LeasePathFlavor = typeof posix | typeof win32

export function resolveLeasePathFlavor(
  executionHostId: ExecutionHostId,
  path: string
): LeasePathFlavor {
  // Why: backslash is legal in a POSIX SSH path, so only authoritative remote-platform metadata
  // may select Win32 remotely. Local drive and either UNC spelling are self-identifying.
  const sshTargetId = getSshTargetIdForExecutionHost(executionHostId)
  if (sshTargetId) {
    return getRegisteredSshState(sshTargetId)?.remotePlatform === 'win32' ? win32 : posix
  }
  if (executionHostId !== 'local') {
    return posix
  }
  return process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)/.test(path)
    ? win32
    : posix
}

export function createLocalLeaseFilesystem(): LeaseHostFilesystem {
  return {
    async readDir(path): Promise<DirEntry[]> {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
    },
    async readFile(path) {
      return { content: await readFile(path, 'utf8'), isBinary: false }
    },
    async writeFile(path, content) {
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
    },
    async rename(oldPath, newPath) {
      await rename(oldPath, newPath)
    },
    async stat(path) {
      const value = await stat(path)
      return {
        size: value.size,
        type: value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file',
        mtime: value.mtimeMs,
        mtimeMs: value.mtimeMs
      }
    },
    async createDir(path) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    },
    async createDirNoClobber(path) {
      await mkdir(path, { recursive: false, mode: 0o700 })
    }
  }
}
