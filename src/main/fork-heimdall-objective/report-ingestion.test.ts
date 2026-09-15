import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import {
  MAX_OBJECTIVE_REPORT_BYTES,
  issueObjectiveReportPath,
  readObjectiveRoleReport,
  resolveExpectedObjectiveReportPath
} from './report-ingestion'

const temporaryDirectories: string[] = []

async function localFolderTarget(): Promise<ObjectiveWorkspaceTarget> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'orca-objective-report-'))
  temporaryDirectories.push(workspacePath)
  return {
    kind: 'folder',
    executionHostId: 'local',
    workspacePath,
    fileProvider: null
  }
}

function remoteFolderTarget(provider: IFilesystemProvider): ObjectiveWorkspaceTarget {
  return {
    kind: 'folder',
    executionHostId: 'ssh:objective-report-test',
    workspacePath: '/srv/objective',
    fileProvider: provider
  }
}

afterEach(async () => {
  unregisterSshGitProvider('objective-report-git-test')
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('objective role report ingestion', () => {
  it('issues a fingerprint-safe path beneath the objective report directory', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, '../../mailbox-path\0with unsafe text')

    expect(dirname(path)).toBe(
      join(target.workspacePath, '.orca', 'heimdall', 'objective', 'reports')
    )
    expect(basename(path)).toMatch(/^[0-9a-f]{64}\.json$/u)
    await expect(
      resolveExpectedObjectiveReportPath(target, '../../mailbox-path\0with unsafe text')
    ).resolves.toBe(path)
  })

  it('derives a remote Git report directory through the routed Git and file providers', async () => {
    const gitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: '/srv/main/.git/worktrees/objective\n',
        stderr: ''
      })
    }
    registerSshGitProvider('objective-report-git-test', gitProvider as never)
    const createDir = vi.fn().mockResolvedValue(undefined)
    const runtimeTarget = {
      executionHostId: 'ssh:objective-report-git-test',
      worktree: {
        id: 'objective-worktree',
        repoId: 'objective-repo',
        path: '/srv/objective',
        git: {
          path: '/srv/objective',
          branch: 'objective',
          isBare: false,
          isMainWorktree: false
        }
      } as unknown as RuntimeGitTarget['worktree']
    } satisfies RuntimeGitTarget
    const target: ObjectiveWorkspaceTarget = {
      kind: 'git',
      executionHostId: 'ssh:objective-report-git-test',
      workspacePath: '/srv/objective',
      fileProvider: { createDir } as unknown as IFilesystemProvider,
      gitTarget: runtimeTarget
    }

    const path = await issueObjectiveReportPath(target, 'git-attempt')

    expect(dirname(path)).toBe('/srv/main/.git/worktrees/objective/orca-heimdall/objective/reports')
    expect(createDir).toHaveBeenCalledWith(dirname(path))
    expect(gitProvider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--absolute-git-dir'],
      '/srv/objective'
    )
  })

  it('refuses an arbitrary mailbox path before stat or read reaches the host', async () => {
    const stat = vi.fn()
    const readFile = vi.fn()
    const provider = { stat, readFile } as unknown as IFilesystemProvider
    const target = remoteFolderTarget(provider)

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'attempt-1',
        mailboxReportPath: '/tmp/attacker-selected.json',
        role: 'planner'
      })
    ).resolves.toEqual({ ok: false, reason: 'path-mismatch' })
    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a report above 256 KiB without parsing it', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'oversize-attempt')
    await writeFile(path, Buffer.alloc(MAX_OBJECTIVE_REPORT_BYTES + 1, 0x20))

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'oversize-attempt',
        mailboxReportPath: path,
        role: 'planner'
      })
    ).resolves.toEqual({ ok: false, reason: 'oversize' })
  })

  it('rejects structurally invalid strict-schema reports', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'malformed-attempt')
    await writeFile(path, JSON.stringify({ plan: [], untrusted: true }))

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'malformed-attempt',
        mailboxReportPath: path,
        role: 'planner'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('distinguishes a complete report for the wrong role from malformed JSON', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'role-attempt')
    await writeFile(
      path,
      JSON.stringify({ verdict: 'approve', criteriaResults: [], summary: 'Review complete.' })
    )

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'role-attempt',
        mailboxReportPath: path,
        role: 'integrator'
      })
    ).resolves.toEqual({ ok: false, reason: 'role-mismatch' })
  })

  it('requires an implementer report to name the dispatched task', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'task-attempt')
    await writeFile(
      path,
      JSON.stringify({
        taskKey: 'different-task',
        summary: 'Implemented the requested behavior.',
        filesModified: ['src/changed.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified.' }]
      })
    )

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'task-attempt',
        mailboxReportPath: path,
        role: 'implementer',
        taskKey: 'expected-task'
      })
    ).resolves.toEqual({ ok: false, reason: 'task-mismatch' })
  })

  it('reads the exact issued remote path with a host-enforced 256 KiB limit', async () => {
    const body = JSON.stringify({
      verdict: 'approve',
      criteriaResults: [],
      summary: 'Remote review complete.'
    })
    const lstat = vi.fn().mockResolvedValue({
      size: Buffer.byteLength(body),
      type: 'file',
      mtime: 1,
      mtimeMs: 1,
      dev: 2,
      ino: 3
    })
    const readFile = vi.fn().mockResolvedValue({ content: body, isBinary: false })
    const realpath = vi.fn(async (path: string) => path)
    const provider = { lstat, readFile, realpath } as unknown as IFilesystemProvider
    const target = remoteFolderTarget(provider)
    const path = await resolveExpectedObjectiveReportPath(target, 'remote-attempt')

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'remote-attempt',
      mailboxReportPath: path,
      role: 'reviewer'
    })

    expect(result.ok).toBe(true)
    expect(lstat).toHaveBeenCalledWith(path)
    expect(readFile).toHaveBeenCalledWith(path, {
      maxTextBytes: MAX_OBJECTIVE_REPORT_BYTES,
      maxBinaryBytes: MAX_OBJECTIVE_REPORT_BYTES
    })
  })

  it('rejects a local report whose issued leaf was replaced by a symlink', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'symlink-leaf')
    const source = join(target.workspacePath, 'attacker-report.json')
    await writeFile(
      source,
      JSON.stringify({ verdict: 'approve', criteriaResults: [], summary: 'x' })
    )
    await symlink(source, path)

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'symlink-leaf',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a local report redirected through a symlinked metadata ancestor', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'symlink-ancestor')
    const outside = await mkdtemp(join(tmpdir(), 'orca-objective-report-outside-'))
    temporaryDirectories.push(outside)
    const redirectedDirectory = join(outside, 'heimdall', 'objective', 'reports')
    await mkdir(redirectedDirectory, { recursive: true })
    await writeFile(
      join(redirectedDirectory, basename(path)),
      JSON.stringify({ verdict: 'approve', criteriaResults: [], summary: 'x' })
    )
    await rm(join(target.workspacePath, '.orca'), { recursive: true, force: true })
    await symlink(outside, join(target.workspacePath, '.orca'))

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'symlink-ancestor',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  it('fails closed before a remote read when secure lstat is unavailable', async () => {
    const readFile = vi.fn()
    const provider = {
      readFile,
      realpath: vi.fn(async (path: string) => path)
    } as unknown as IFilesystemProvider
    const target = remoteFolderTarget(provider)
    const path = await resolveExpectedObjectiveReportPath(target, 'remote-no-lstat')

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'remote-no-lstat',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a remote report whose canonical ancestor escapes workspace authority', async () => {
    const targetRoot = '/srv/objective'
    const provider = {
      lstat: vi.fn(),
      readFile: vi.fn(),
      realpath: vi.fn(async (path: string) =>
        path === targetRoot ? targetRoot : path.replace('/srv/objective/.orca', '/outside')
      )
    } as unknown as IFilesystemProvider
    const target = remoteFolderTarget(provider)
    const path = await resolveExpectedObjectiveReportPath(target, 'remote-ancestor')

    await expect(
      readObjectiveRoleReport({
        target,
        attemptFingerprint: 'remote-ancestor',
        mailboxReportPath: path,
        role: 'reviewer'
      })
    ).resolves.toEqual({ ok: false, reason: 'malformed' })
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('returns a validated report and a digest only from the issued host path', async () => {
    const target = await localFolderTarget()
    const path = await issueObjectiveReportPath(target, 'valid-attempt')
    await writeFile(
      path,
      JSON.stringify({
        plan: [
          {
            taskKey: 'task-1',
            title: 'Implement behavior',
            spec: 'Implement the objective behavior completely.',
            deps: [],
            criteria: [{ body: 'Behavior works', shellCheckable: true, checkCommand: 'true' }],
            declaresDependencyChange: false
          }
        ]
      })
    )

    const result = await readObjectiveRoleReport({
      target,
      attemptFingerprint: 'valid-attempt',
      mailboxReportPath: path,
      role: 'planner'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.report.plan[0]?.taskKey).toBe('task-1')
      expect(result.reportDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect(result.path).toBe(path)
    }
  })
})
