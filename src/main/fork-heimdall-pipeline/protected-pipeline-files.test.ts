import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  captureProtectedDigest,
  compareProtectedDigest,
  MAX_PROTECTED_PIPELINE_FILE_BYTES,
  MAX_PROTECTED_PIPELINE_FILES,
  PROTECTED_PIPELINE_OVER_CAP_PATH,
  ProtectedDigestUnverifiableError
} from './protected-pipeline-files'

const directories: string[] = []

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'pipeline-protected-'))
  directories.push(workspace)
  return workspace
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('captureProtectedDigest', () => {
  it('treats absent protected directories as empty', async () => {
    const workspacePath = await createWorkspace()
    const missingOrca = await captureProtectedDigest({ executionHostId: 'local', workspacePath })
    await mkdir(join(workspacePath, '.orca'))
    const missingPipelines = await captureProtectedDigest({
      executionHostId: 'local',
      workspacePath
    })

    expect(missingOrca).toEqual({ status: 'ok', entries: [] })
    expect(missingPipelines).toEqual({ status: 'ok', entries: [] })
  })

  it('detects file content changes, additions, and deletions by relative path', async () => {
    const workspacePath = await createWorkspace()
    const pipelinesPath = join(workspacePath, '.orca', 'pipelines')
    await mkdir(pipelinesPath, { recursive: true })
    await writeFile(join(pipelinesPath, 'changed.yaml'), 'before')
    await writeFile(join(pipelinesPath, 'deleted.yaml'), 'remove')
    const before = await captureProtectedDigest({ executionHostId: 'local', workspacePath })

    await writeFile(join(pipelinesPath, 'changed.yaml'), 'after')
    await rm(join(pipelinesPath, 'deleted.yaml'))
    await writeFile(join(pipelinesPath, 'added.yaml'), 'new')
    const after = await captureProtectedDigest({ executionHostId: 'local', workspacePath })

    expect(compareProtectedDigest(before, after).changed).toEqual([
      '.orca/pipelines/added.yaml',
      '.orca/pipelines/changed.yaml',
      '.orca/pipelines/deleted.yaml'
    ])
  })

  it('records symlink targets without hashing or traversing their targets', async () => {
    const workspacePath = await createWorkspace()
    const outsidePath = await createWorkspace()
    const pipelinesPath = join(workspacePath, '.orca', 'pipelines')
    const outsideFile = join(outsidePath, 'secret.yaml')
    await mkdir(pipelinesPath, { recursive: true })
    await writeFile(outsideFile, 'outside')
    await symlink(outsideFile, join(pipelinesPath, 'link.yaml'))

    const digest = await captureProtectedDigest({ executionHostId: 'local', workspacePath })

    expect(digest).toEqual({
      status: 'ok',
      entries: [{ path: '.orca/pipelines/link.yaml', kind: 'symlink', target: outsideFile }]
    })
  })

  it('records a symlink at .orca/pipelines itself without following its directory target', async () => {
    const workspacePath = await createWorkspace()
    const outsidePath = await createWorkspace()
    await mkdir(join(workspacePath, '.orca'))
    await symlink(outsidePath, join(workspacePath, '.orca', 'pipelines'))

    const digest = await captureProtectedDigest({ executionHostId: 'local', workspacePath })

    expect(digest).toEqual({
      status: 'ok',
      entries: [{ path: '.orca/pipelines', kind: 'symlink', target: outsidePath }]
    })
  })
  it('records a symlink at .orca without traversing its pipeline directory', async () => {
    const workspacePath = await createWorkspace()
    const outsidePath = await createWorkspace()
    await symlink(outsidePath, join(workspacePath, '.orca'))

    const digest = await captureProtectedDigest({ executionHostId: 'local', workspacePath })

    expect(digest).toEqual({
      status: 'ok',
      entries: [{ path: '.orca', kind: 'symlink', target: outsidePath }]
    })
  })

  it('fails closed at either file-count or per-file size cap', async () => {
    const workspacePath = await createWorkspace()
    const pipelinesPath = join(workspacePath, '.orca', 'pipelines')
    await mkdir(pipelinesPath, { recursive: true })
    await Promise.all(
      Array.from({ length: MAX_PROTECTED_PIPELINE_FILES + 1 }, (_, index) =>
        writeFile(join(pipelinesPath, `file-${index}.yaml`), 'pipeline')
      )
    )
    const tooMany = await captureProtectedDigest({ executionHostId: 'local', workspacePath })
    expect(tooMany).toEqual({ status: 'over-cap' })
    expect(compareProtectedDigest({ status: 'ok', entries: [] }, tooMany).changed).toEqual([
      PROTECTED_PIPELINE_OVER_CAP_PATH
    ])
    expect(compareProtectedDigest(tooMany, { status: 'ok', entries: [] }).changed).toEqual([
      PROTECTED_PIPELINE_OVER_CAP_PATH
    ])

    await rm(pipelinesPath, { recursive: true, force: true })
    await mkdir(pipelinesPath, { recursive: true })
    await writeFile(
      join(pipelinesPath, 'large.yaml'),
      Buffer.alloc(MAX_PROTECTED_PIPELINE_FILE_BYTES + 1, 0x61)
    )
    await expect(
      captureProtectedDigest({ executionHostId: 'local', workspacePath })
    ).resolves.toEqual({
      status: 'over-cap'
    })
  })
  it('refuses an SSH host without falling back to local files', async () => {
    const workspacePath = await createWorkspace()
    const pipelinesPath = join(workspacePath, '.orca', 'pipelines')
    await mkdir(pipelinesPath, { recursive: true })
    await writeFile(join(pipelinesPath, 'local-only.yaml'), 'must not be read')

    await expect(
      captureProtectedDigest({
        executionHostId: toSshExecutionHostId('pipeline-protected-unserved'),
        workspacePath
      })
    ).rejects.toBeInstanceOf(ProtectedDigestUnverifiableError)
  })
})
