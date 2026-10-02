import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-git-dispatch'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import { ensurePipelineTracked, reincludePipelineFiles } from './pipeline-tracking'

const target = {
  repoPath: '/repo',
  worktreePath: '/repo/worktree',
  connectionId: null,
  pipelineId: 'bugfix-fast'
}
const pipelinePath = '.orca/pipelines/bugfix-fast.yaml'
const detail = "ignored by a rule outside Orca's .orca line"

describe('ensurePipelineTracked', () => {
  it('returns tracked without reading or writing ignore rules when Git allows the pipeline', async () => {
    const deps = {
      checkIgnoredPaths: vi.fn(async () => []),
      readGitignore: vi.fn(async () => null),
      writeGitignore: vi.fn(async (_content: string) => {})
    }

    await expect(ensurePipelineTracked(target, deps)).resolves.toEqual({ status: 'tracked' })
    expect(deps.checkIgnoredPaths).toHaveBeenCalledTimes(1)
    expect(deps.readGitignore).not.toHaveBeenCalled()
    expect(deps.writeGitignore).not.toHaveBeenCalled()
  })

  it('rewrites a bare .orca rule and reports success after Git rechecks the file', async () => {
    let checks = 0
    const writes: string[] = []
    const deps = {
      checkIgnoredPaths: vi.fn(async () => {
        checks += 1
        return checks === 1 ? [pipelinePath] : []
      }),
      readGitignore: vi.fn(async () => 'node_modules/\n.orca\n'),
      writeGitignore: vi.fn(async (content: string) => {
        writes.push(content)
      })
    }

    await expect(ensurePipelineTracked(target, deps)).resolves.toEqual({
      status: 'rewrote-orca-line'
    })
    expect(writes).toEqual(['node_modules/\n.orca/*\n!.orca/pipelines/\n'])
    expect(deps.checkIgnoredPaths).toHaveBeenCalledTimes(2)
  })

  it('leaves a user-authored .orca/ rule untouched and explains the remaining ignore', async () => {
    const deps = {
      checkIgnoredPaths: vi.fn(async () => [pipelinePath]),
      readGitignore: vi.fn(async () => '.orca/\n'),
      writeGitignore: vi.fn(async (_content: string) => {})
    }

    await expect(ensurePipelineTracked(target, deps)).resolves.toEqual({
      status: 'still-ignored',
      detail
    })
    expect(deps.writeGitignore).not.toHaveBeenCalled()
    expect(deps.checkIgnoredPaths).toHaveBeenCalledTimes(1)
  })

  it('reports still-ignored when no root .gitignore is available to rewrite', async () => {
    const deps = {
      checkIgnoredPaths: vi.fn(async () => [pipelinePath]),
      readGitignore: vi.fn(async () => null),
      writeGitignore: vi.fn(async (_content: string) => {})
    }

    await expect(ensurePipelineTracked(target, deps)).resolves.toEqual({
      status: 'still-ignored',
      detail
    })
    expect(deps.writeGitignore).not.toHaveBeenCalled()
  })

  it('reports still-ignored when Git ignores the pipeline after the Orca rule is rewritten', async () => {
    let checks = 0
    const deps = {
      checkIgnoredPaths: vi.fn(async () => {
        checks += 1
        return [pipelinePath]
      }),
      readGitignore: vi.fn(async () => '.orca\n'),
      writeGitignore: vi.fn(async (_content: string) => {})
    }

    await expect(ensurePipelineTracked(target, deps)).resolves.toEqual({
      status: 'still-ignored',
      detail
    })
    expect(deps.writeGitignore).toHaveBeenCalledTimes(1)
    expect(deps.checkIgnoredPaths).toHaveBeenCalledTimes(2)
  })
})

describe('reincludePipelineFiles', () => {
  it('returns still-ignored after its explicit write when the pipeline remains ignored', async () => {
    const writes: string[] = []
    const deps = {
      checkIgnoredPaths: vi.fn(async () => [pipelinePath]),
      readGitignore: vi.fn(async () => '.orca/\n'),
      writeGitignore: vi.fn(async (content: string) => {
        writes.push(content)
      })
    }

    await expect(reincludePipelineFiles(target, deps)).resolves.toEqual({
      status: 'still-ignored',
      detail
    })
    expect(writes).toEqual(['.orca/*\n!.orca/pipelines/\n'])
    expect(deps.checkIgnoredPaths).toHaveBeenCalledTimes(1)
  })
})

describe('native Git and host routing', () => {
  let root: string
  let worktreePath: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-pipeline-tracking-'))
    worktreePath = join(root, 'repo')
    mkdirSync(worktreePath)
    const globalConfig = join(root, 'gitconfig')
    const globalIgnore = join(root, 'ignore')
    writeFileSync(globalConfig, '')
    writeFileSync(globalIgnore, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    await gitExecFileAsync(['init', '-q'], { cwd: worktreePath })
    await gitExecFileAsync(['config', '--file', globalConfig, 'core.excludesFile', globalIgnore], {
      cwd: worktreePath
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('makes a bare Orca ignore rule trackable using native Git', async () => {
    mkdirSync(join(worktreePath, '.orca', 'pipelines'), { recursive: true })
    writeFileSync(join(worktreePath, pipelinePath), 'pipeline: true\n')
    writeFileSync(join(worktreePath, '.gitignore'), '.orca\r\n')
    const nativeTarget = { ...target, repoPath: worktreePath, worktreePath }

    await expect(ensurePipelineTracked(nativeTarget)).resolves.toEqual({
      status: 'rewrote-orca-line'
    })
    expect(readFileSync(join(worktreePath, '.gitignore'), 'utf8')).toBe(
      '.orca/*\r\n!.orca/pipelines/\r\n'
    )
    const untracked = await gitExecFileAsync(['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath
    })
    expect(untracked.stdout.split(/\r?\n/)).toContain(pipelinePath)
  })

  it('re-includes a user-authored .orca/ rule only on the explicit path', async () => {
    mkdirSync(join(worktreePath, '.orca', 'pipelines'), { recursive: true })
    writeFileSync(join(worktreePath, pipelinePath), 'pipeline: true\n')
    writeFileSync(join(worktreePath, '.gitignore'), '.orca/\r\n')
    const nativeTarget = { ...target, repoPath: worktreePath, worktreePath }

    await expect(reincludePipelineFiles(nativeTarget)).resolves.toEqual({ status: 'tracked' })
    expect(readFileSync(join(worktreePath, '.gitignore'), 'utf8')).toBe(
      '.orca/*\r\n!.orca/pipelines/\r\n'
    )
    const untracked = await gitExecFileAsync(['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath
    })
    expect(untracked.stdout.split(/\r?\n/)).toContain(pipelinePath)
  })

  it('does not fall back to native Git when the SSH Git host is unavailable', async () => {
    writeFileSync(join(worktreePath, '.gitignore'), '.orca\n')
    const remoteTarget = {
      ...target,
      repoPath: worktreePath,
      worktreePath,
      connectionId: `missing-git-${basename(root)}`
    }

    await expect(ensurePipelineTracked(remoteTarget)).rejects.toThrow(
      SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
    )
    expect(readFileSync(join(worktreePath, '.gitignore'), 'utf8')).toBe('.orca\n')
  })

  it('does not fall back to native files when the SSH filesystem host is unavailable', async () => {
    writeFileSync(join(worktreePath, '.gitignore'), '.orca/\n')
    const remoteTarget = {
      ...target,
      repoPath: worktreePath,
      worktreePath,
      connectionId: `missing-files-${basename(root)}`
    }

    await expect(reincludePipelineFiles(remoteTarget)).rejects.toThrow(
      SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    )
    expect(readFileSync(join(worktreePath, '.gitignore'), 'utf8')).toBe('.orca/\n')
  })
})
