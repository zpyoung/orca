import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ObjectiveWorkspaceTarget } from './content-identity'

export async function createLocalFolderTarget(
  temporaryDirectories: string[],
  prefix: string
): Promise<ObjectiveWorkspaceTarget> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(workspacePath)
  return { kind: 'folder', executionHostId: 'local', workspacePath, fileProvider: null }
}

export async function cleanupTemporaryDirectories(temporaryDirectories: string[]): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
}
