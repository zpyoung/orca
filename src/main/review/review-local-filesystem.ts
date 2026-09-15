import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { ReviewFilesystem } from './review-run-contract'

export function createLocalReviewFilesystem(): ReviewFilesystem {
  return {
    createDir: async (path) => void (await mkdir(path, { recursive: true })),
    readDir: async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      })),
    readFile: async (path) => ({ content: await readFile(path, 'utf8') }),
    writeFile: async (path, content) => void (await writeFile(path, content, 'utf8')),
    rename,
    deletePath: async (path, recursive = false) =>
      void (await rm(path, { recursive, force: true })),
    stat
  }
}
