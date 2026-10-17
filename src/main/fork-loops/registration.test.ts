import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientChannel } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { snapshotWorkingTree } from './loop-diff'
import { validateLoopCheckHost } from './loop-check'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { createLocalLoopFilesystem } from './loop-notes-file'
import { buildSshGitCommand, createSshShellGitRunner, resolveLoopTargets } from './registration'

const sshState = vi.hoisted(() => {
  const state: { platform: string | undefined; git: unknown; manager: unknown } = {
    platform: undefined,
    git: undefined,
    manager: null
  }
  return state
})

vi.mock('../ssh/ssh-target-registry', () => ({
  getRegisteredSshState: vi.fn(() => ({ remotePlatform: sshState.platform })),
  getSshConnectionManager: vi.fn(() => sshState.manager)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(() => ({}))
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn(() => sshState.git)
}))
vi.mock('../runtime/worktree-launch-host-repo', () => ({
  resolveWorktreeHostRouting: vi.fn(() => ({
    kind: 'resolved',
    hostId: toSshExecutionHostId('target-1')
  }))
}))

const runtime = {
  showManagedWorktree: async () => ({ repoId: 'repo-1', path: '/work' })
}
const store = {
  getRepo: () => undefined,
  getRepos: () => []
}

describe('resolveLoopTargets for SSH worktrees', () => {
  beforeEach(() => {
    sshState.platform = undefined
    sshState.git = undefined
    sshState.manager = null
  })

  it('carries a win32 host platform so the Windows SSH check is rejected', async () => {
    sshState.platform = 'win32'
    const targets = await resolveLoopTargets(runtime, store, 'repo-1::/work')
    expect(targets.check).toMatchObject({ type: 'ssh', remotePlatform: 'win32' })
    expect(validateLoopCheckHost(targets.check)).toMatchObject({
      ok: false,
      code: 'loop_check_unsupported_host'
    })
  })

  it('carries a linux host platform and accepts the check', async () => {
    sshState.platform = 'linux'
    const targets = await resolveLoopTargets(runtime, store, 'repo-1::/work')
    expect(targets.check).toMatchObject({ type: 'ssh', remotePlatform: 'linux' })
    expect(validateLoopCheckHost(targets.check)).toEqual({ ok: true })
  })
})

describe('resolveLoopTargets git route over SSH', () => {
  beforeEach(() => {
    sshState.git = undefined
    sshState.manager = null
  })

  it('sends env-bearing git calls through the shell and the rest through the provider', async () => {
    const providerExec = vi.fn(async () => ({ stdout: 'provider', stderr: '' }))
    sshState.git = { exec: providerExec }
    const commands: string[] = []
    const shell = localShellConnection()
    const connection = {
      getState: () => ({ status: 'connected' }),
      usesSystemSshTransport: shell.usesSystemSshTransport,
      exec: async (command: string) => {
        commands.push(command)
        return shell.exec('true')
      }
    }
    sshState.manager = { getConnection: () => connection }
    sshState.platform = 'linux'
    const targets = await resolveLoopTargets(runtime, store, 'repo-1::/work')
    const runGit = targets.workspace.runGit
    expect(await runGit?.(['status'])).toEqual({ stdout: 'provider', stderr: '' })
    expect(providerExec).toHaveBeenCalledWith(['status'], '/work')
    expect(commands).toEqual([])
    await runGit?.(['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: '/work/.git/i' } })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(
      "cd '/work' && env GIT_INDEX_FILE='/work/.git/i' git 'read-tree' 'HEAD'"
    )
  })
})

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      env[key] = value
    }
  }
  return env
}

function localShellConnection(options: { rcOutput?: string } = {}) {
  return {
    usesSystemSshTransport: () => false,
    exec: async (command: string): Promise<ClientChannel> => {
      // the rc prefix stands in for output the user's login shell prints before the command runs
      const script = options.rcOutput
        ? `printf %s ${shellEscape(options.rcOutput)}\n${command}`
        : command
      const child = spawn('sh', ['-c', script], { env: cleanGitEnv() })
      const channel = Object.assign(new EventEmitter(), {
        stderr: child.stderr,
        stdin: child.stdin,
        resume: () => channel,
        close: () => child.kill()
      })
      child.stdout.on('data', (data) => channel.emit('data', data))
      child.on('close', (code) => channel.emit('close', code))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand only touches on/off/once/resume/close/stdin/stderr, all present on this stand-in.
      return channel as unknown as ClientChannel
    }
  }
}

describe('buildSshGitCommand', () => {
  it('quotes the working directory, every argument, and the env values', () => {
    expect(
      buildSshGitCommand("/work/it's here", ['commit', '-m', "a 'b' $(c)"], {
        GIT_INDEX_FILE: '/tmp/x y.index'
      })
    ).toBe(
      "cd '/work/it'\\''s here' && env GIT_INDEX_FILE='/tmp/x y.index' git 'commit' '-m' 'a '\\''b'\\'' $(c)'"
    )
  })

  it('omits env when there are no variables', () => {
    expect(buildSshGitCommand('/work', ['status'], {})).toBe("cd '/work' && git 'status'")
  })

  it('rejects an environment variable name that is not a plain identifier', () => {
    expect(() => buildSshGitCommand('/work', ['status'], { 'A=B; rm': '1' })).toThrow(
      'Invalid environment variable name'
    )
  })
})

describe('createSshShellGitRunner', () => {
  it('refuses Windows SSH hosts', async () => {
    const getConnection = vi.fn()
    const runGit = createSshShellGitRunner({
      connectionId: 'target-1',
      cwd: '/work',
      remotePlatform: 'win32',
      getConnection
    })
    await expect(runGit(['status'], { env: { GIT_INDEX_FILE: 'x' } })).rejects.toThrow('Windows')
    expect(getConnection).not.toHaveBeenCalled()
  })

  describe('against a real repository', () => {
    let root = ''

    function runnerFor(cwd: string, rcOutput?: string) {
      const connection = localShellConnection({ rcOutput })
      return createSshShellGitRunner({
        connectionId: 'target-1',
        cwd,
        remotePlatform: 'linux',
        getConnection: () => connection
      })
    }

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca-loop-ssh-git-'))
      const run = runnerFor(root)
      await run(['init', '-q'])
      await run(['config', 'user.email', 'loop@example.com'])
      await run(['config', 'user.name', 'Loop'])
      await writeFile(join(root, 'tracked.txt'), 'one\n')
      await run(['add', '-A'])
      await run(['commit', '-q', '-m', 'initial'])
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('lets snapshotWorkingTree build a tree through the private index', async () => {
      const runGit = runnerFor(root)
      await writeFile(join(root, 'new file.txt'), 'two\n')
      const snapshot = await snapshotWorkingTree({
        kind: 'git',
        workspacePath: root,
        pathFlavor: 'posix',
        fs: createLocalLoopFilesystem(),
        runGit
      })
      expect(snapshot?.treeId).toMatch(/^[0-9a-f]{40,64}$/)
      const listing = await runGit(['ls-tree', '--name-only', snapshot?.treeId ?? ''])
      expect(listing.stdout.split('\n')).toContain('new file.txt')
      const staged = await runGit(['diff', '--cached', '--name-only'])
      expect(staged.stdout).toBe('')
    })

    it('ignores login-shell output printed ahead of git', async () => {
      const runGit = runnerFor(root, 'welcome banner\n')
      expect((await runGit(['rev-parse', '--is-inside-work-tree'])).stdout).toBe('true\n')
    })

    it('rejects with git stderr on a non-zero exit', async () => {
      await expect(runnerFor(root)(['rev-parse', '--verify', 'no-such-ref'])).rejects.toThrow()
    })
  })
})
