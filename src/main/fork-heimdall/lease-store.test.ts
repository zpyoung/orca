import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import type { IFilesystemProvider } from '../providers/types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  HostRoutedLeaseStore,
  LeaseLostError,
  makeWorkspaceKey,
  type LeaseWorkspaceTarget
} from './lease-store'

class MemoryFilesystem {
  readonly directories = new Set(['/workspace', '/workspace/.orca', '/workspace/.orca/heimdall'])
  readonly directoryMtimes = new Map<string, number>()
  readonly files = new Map<string, { content: string; mtime: number }>()
  now = 1_000
  fail = false
  beforePublish: ((path: string, content: string) => Promise<void>) | null = null
  beforeStat: ((path: string) => Promise<void>) | null = null

  private check(): void {
    if (this.fail) {
      throw new Error('transport unavailable')
    }
  }

  async readDir(path: string): Promise<DirEntry[]> {
    this.check()
    const slashPrefix = `${path}/`
    const backslashPrefix = `${path}\\`
    return [...this.directories].flatMap((entry) => {
      const name = entry.startsWith(slashPrefix)
        ? entry.slice(slashPrefix.length)
        : entry.startsWith(backslashPrefix)
          ? entry.slice(backslashPrefix.length)
          : null
      return name !== null && !/[\\/]/.test(name)
        ? [{ name, isDirectory: true, isSymlink: false }]
        : []
    })
  }

  async readFile(path: string): Promise<{ content: string; isBinary: boolean }> {
    this.check()
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    }
    return { content: file.content, isBinary: false }
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.check()
    // Real writes truncate before they write, so a concurrent reader can see an empty file.
    const existing = this.files.get(path)
    if (existing) {
      existing.content = ''
    }
    await this.beforePublish?.(path, content)
    this.files.set(path, { content, mtime: this.now })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.check()
    const file = this.files.get(oldPath)
    if (!file) {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    }
    await this.beforePublish?.(newPath, file.content)
    this.files.delete(oldPath)
    this.files.set(newPath, file)
  }

  async stat(path: string): Promise<{ size: number; type: 'file' | 'directory'; mtime: number }> {
    this.check()
    await this.beforeStat?.(path)
    const file = this.files.get(path)
    if (file) {
      return { size: file.content.length, type: 'file', mtime: file.mtime }
    }
    if (this.directories.has(path)) {
      return { size: 0, type: 'directory', mtime: this.directoryMtimes.get(path) ?? 0 }
    }
    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  }

  async createDir(path: string): Promise<void> {
    this.check()
    if (!this.directories.has(path)) {
      this.directoryMtimes.set(path, this.now)
    }
    this.directories.add(path)
  }

  async createDirNoClobber(path: string): Promise<void> {
    this.check()
    if (this.directories.has(path)) {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    }
    this.directories.add(path)
    this.directoryMtimes.set(path, this.now)
  }

  async deletePath(path: string): Promise<void> {
    this.check()
    this.directories.delete(path)
    this.files.delete(path)
  }

  asProvider(): IFilesystemProvider {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lease-store.ts only calls readDir/readFile/writeFile/rename/stat/createDir/createDirNoClobber/deletePath on this provider, all implemented above.
    return this as unknown as IFilesystemProvider
  }
}

function remoteTarget(
  fs: MemoryFilesystem,
  workspacePath = '/workspace',
  executionHostId: LeaseWorkspaceTarget['executionHostId'] = 'ssh:host-a'
): LeaseWorkspaceTarget {
  return {
    kind: 'folder',
    executionHostId,
    workspacePath,
    watcherId: 'watcher-1',
    fileProvider: fs.asProvider()
  }
}

function createOperationBarrier(): {
  reached: Promise<void>
  wait(): Promise<void>
  release(): void
} {
  let announce!: () => void
  let resume!: () => void
  const reached = new Promise<void>((resolve) => {
    announce = resolve
  })
  const released = new Promise<void>((resolve) => {
    resume = resolve
  })
  return {
    reached,
    async wait(): Promise<void> {
      announce()
      await released
    },
    release(): void {
      resume()
    }
  }
}

function releasedState(content: string): boolean | null {
  const parsed: unknown = JSON.parse(content)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('released' in parsed) ||
    typeof parsed.released !== 'boolean'
  ) {
    return null
  }
  return parsed.released
}

const temporaryPaths: string[] = []
const GIT_TEST_HOST = 'lease-git-path'
afterEach(() => {
  unregisterSshGitProvider(GIT_TEST_HOST)
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('host-routed epoch lease', () => {
  it('acquires and refuses another holder while the host-mtime lease is live', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })

    const first = await store.acquireOrRenew(key, 'owner-a', 90_000)
    const second = await store.acquireOrRenew(key, 'owner-b', 90_000)

    expect(first.status).toBe('held')
    expect(second).toMatchObject({
      status: 'refused',
      reason: 'held-by-other',
      holder: 'owner-a',
      epoch: 1
    })
  })

  it('refuses release by a different holder at the current epoch', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })
    const first = await store.acquireOrRenew(key, 'owner-a', 90_000)
    if (first.status !== 'held') {
      throw new Error('expected lease')
    }

    await expect(store.release(key, 'owner-b', first.epoch)).rejects.toBeInstanceOf(LeaseLostError)
    await expect(store.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'refused',
      holder: 'owner-a',
      epoch: first.epoch
    })
  })

  it('takes over at a higher epoch only after host-clock expiry', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })
    await store.acquireOrRenew(key, 'owner-a', 90_000)
    fs.now += 90_001

    const takeover = await store.acquireOrRenew(key, 'owner-b', 90_000)
    expect(takeover).toMatchObject({ status: 'held', epoch: 2 })
  })

  it('holds an incomplete epoch fail-closed until its host-directory mtime expires', async () => {
    const fs = new MemoryFilesystem()
    const leaseDirectory = '/workspace/.orca/heimdall/lease'
    await fs.createDir(leaseDirectory)
    await fs.createDirNoClobber(`${leaseDirectory}/epoch-1`)
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })

    await expect(store.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'unverifiable',
      reason: expect.stringContaining('incomplete')
    })
    fs.now += 90_001
    await expect(store.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 2
    })
  })

  it.each([
    { crashKind: 'empty', content: '' },
    { crashKind: 'truncated', content: '{"holder":"owner-a"' },
    { crashKind: 'malformed', content: JSON.stringify({ holder: 'owner-a' }) }
  ])(
    'expires an $crashKind highest holder from its file mtime, not the older directory mtime',
    async ({ content }) => {
      const fs = new MemoryFilesystem()
      const leaseDirectory = '/workspace/.orca/heimdall/lease'
      const epochDirectory = `${leaseDirectory}/epoch-1`
      const holderPath = `${epochDirectory}/holder.json`
      await fs.createDir(leaseDirectory)
      await fs.createDirNoClobber(epochDirectory)
      fs.now += 90_001
      await fs.writeFile(holderPath, content)
      const key = makeWorkspaceKey('ssh:host-a', '/workspace')
      const store = new HostRoutedLeaseStore({
        resolveTarget: async () => remoteTarget(fs)
      })

      await expect(store.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
        status: 'unverifiable',
        reason: expect.stringContaining('incomplete')
      })
      fs.now += 90_001
      await expect(store.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
        status: 'held',
        epoch: 2
      })
    }
  )

  it('keeps the live holder record readable while a renewal publishes', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const firstStore = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })
    const secondStore = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })
    await firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    const barrier = createOperationBarrier()
    const holderPath = '/workspace/.orca/heimdall/lease/epoch-1/holder.json'
    fs.beforePublish = async (path) => {
      if (path === holderPath) {
        await barrier.wait()
      }
    }

    const renewing = firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    await barrier.reached
    await expect(secondStore.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'refused',
      reason: 'held-by-other',
      holder: 'owner-a',
      epoch: 1
    })
    barrier.release()

    await expect(renewing).resolves.toMatchObject({ status: 'held', epoch: 1 })
    expect([...fs.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([])
  })

  it('rechecks the highest epoch after publishing a holder record', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const firstStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const secondStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const barrier = createOperationBarrier()
    const holderPath = '/workspace/.orca/heimdall/lease/epoch-1/holder.json'
    fs.beforePublish = async (path) => {
      if (path === holderPath) {
        await barrier.wait()
      }
    }

    const publishing = firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    await barrier.reached
    fs.now += 90_001
    await expect(secondStore.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 2
    })
    barrier.release()

    await expect(publishing).resolves.toMatchObject({
      status: 'unverifiable',
      reason: expect.stringContaining('fenced')
    })
  })

  it('rejects renewal and assertHeld under an older epoch', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })
    const first = await store.acquireOrRenew(key, 'owner-a', 90_000)
    if (first.status !== 'held') {
      throw new Error('expected lease')
    }
    fs.now += 90_001
    await store.acquireOrRenew(key, 'owner-b', 90_000)

    await expect(first.guard.assertHeld()).rejects.toBeInstanceOf(LeaseLostError)
    await expect(store.release(key, first.guard.holder, first.epoch)).rejects.toBeInstanceOf(
      LeaseLostError
    )
  })

  it('serializes an in-flight renewal before release marks the epoch released', async () => {
    vi.useFakeTimers()
    try {
      const fs = new MemoryFilesystem()
      const key = makeWorkspaceKey('ssh:host-a', '/workspace')
      const store = new HostRoutedLeaseStore({
        resolveTarget: async () => remoteTarget(fs)
      })
      const first = await store.acquireOrRenew(key, 'owner-a', 90_000)
      if (first.status !== 'held') {
        throw new Error('expected lease')
      }
      const holderPath = '/workspace/.orca/heimdall/lease/epoch-1/holder.json'
      const barrier = createOperationBarrier()
      let renewalBlocked = false
      fs.beforePublish = async (path, content) => {
        if (path === holderPath && !renewalBlocked && releasedState(content) === false) {
          renewalBlocked = true
          await barrier.wait()
        }
      }

      const renewal = first.guard.renewLoop()
      vi.advanceTimersByTime(30_000)
      await barrier.reached
      renewal.dispose()
      const releasePromise = store.release(key, first.guard.holder, first.epoch)
      for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve()
      }
      barrier.release()
      await releasePromise
      for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve()
      }

      expect(JSON.parse((await fs.readFile(holderPath)).content)).toMatchObject({
        released: true
      })
      await expect(store.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
        status: 'held',
        epoch: 2
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rechecks the highest epoch after a renewal write before returning held', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const firstStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const secondStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const first = await firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    if (first.status !== 'held') {
      throw new Error('expected lease')
    }
    const barrier = createOperationBarrier()
    const holderPath = '/workspace/.orca/heimdall/lease/epoch-1/holder.json'
    let renewalBlocked = false
    fs.beforePublish = async (path, content) => {
      if (path === holderPath && !renewalBlocked && releasedState(content) === false) {
        renewalBlocked = true
        await barrier.wait()
      }
    }

    const renewing = firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    await barrier.reached
    fs.now += 90_001
    await expect(secondStore.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 2
    })
    barrier.release()

    await expect(renewing).resolves.toMatchObject({
      status: 'unverifiable',
      reason: expect.stringContaining('fenced')
    })
  })

  it('rechecks the highest epoch after assertHeld host operations', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const firstStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const secondStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const first = await firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    if (first.status !== 'held') {
      throw new Error('expected lease')
    }
    const barrier = createOperationBarrier()
    const holderPath = '/workspace/.orca/heimdall/lease/epoch-1/holder.json'
    let statBlocked = false
    fs.beforeStat = async (path) => {
      if (path === holderPath && !statBlocked) {
        statBlocked = true
        await barrier.wait()
      }
    }

    const assertion = first.guard.assertHeld()
    await barrier.reached
    fs.now += 90_001
    await expect(secondStore.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 2
    })
    barrier.release()

    await expect(assertion).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('rechecks the highest epoch when release resumes after host I/O', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const firstStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const secondStore = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const first = await firstStore.acquireOrRenew(key, 'owner-a', 90_000)
    if (first.status !== 'held') {
      throw new Error('expected lease')
    }
    const barrier = createOperationBarrier()
    const holderPath = '/workspace/.orca/heimdall/lease/epoch-1/holder.json'
    let releaseBlocked = false
    fs.beforePublish = async (path, content) => {
      if (path === holderPath && !releaseBlocked && releasedState(content) === true) {
        releaseBlocked = true
        await barrier.wait()
      }
    }

    const releasing = firstStore.release(key, first.guard.holder, first.epoch)
    await barrier.reached
    fs.now += 90_001
    await expect(secondStore.acquireOrRenew(key, 'owner-b', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 2
    })
    barrier.release()

    await expect(releasing).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('rejects assertHeld transport failures as LeaseLostError', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs)
    })
    const first = await store.acquireOrRenew(key, 'owner-a', 90_000)
    if (first.status !== 'held') {
      throw new Error('expected lease')
    }
    fs.fail = true

    await expect(first.guard.assertHeld()).rejects.toEqual(
      expect.objectContaining({
        name: 'LeaseLostError',
        message: expect.stringContaining('transport unavailable')
      })
    )
  })

  it('answers invariant target mismatch as a configuration error', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const store = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs, '/different-workspace')
    })

    await expect(store.acquireOrRenew(key, 'owner', 90_000)).resolves.toEqual({
      status: 'configuration-error',
      reason: 'Lease target does not match its workspace key'
    })
  })

  it('answers transport failure as unverifiable, never held', async () => {
    const fs = new MemoryFilesystem()
    fs.fail = true
    const store = new HostRoutedLeaseStore({ resolveTarget: async () => remoteTarget(fs) })
    await expect(
      store.acquireOrRenew(makeWorkspaceKey('ssh:host-a', '/workspace'), 'owner', 90_000)
    ).resolves.toMatchObject({ status: 'unverifiable' })
  })

  it.each([
    {
      workspacePath: '//server/share/repo',
      leaseDirectory: '\\\\server\\share\\repo\\.orca\\heimdall\\lease'
    },
    {
      workspacePath: '//wsl.localhost/Ubuntu/repo',
      leaseDirectory: '\\\\wsl.localhost\\Ubuntu\\repo\\.orca\\heimdall\\lease'
    }
  ])(
    'preserves local forward-UNC spelling for $workspacePath',
    async ({ workspacePath, leaseDirectory }) => {
      const fs = new MemoryFilesystem()
      const key = makeWorkspaceKey('local', workspacePath)
      const store = new HostRoutedLeaseStore({
        resolveTarget: async () => remoteTarget(fs, workspacePath, 'local')
      })

      await expect(store.acquireOrRenew(key, 'owner', 90_000)).resolves.toMatchObject({
        status: 'held',
        epoch: 1
      })
      expect(fs.directories.has(leaseDirectory)).toBe(true)
    }
  )

  it('keeps a literal backslash in a POSIX SSH workspace name', async () => {
    const fs = new MemoryFilesystem()
    const workspacePath = '/srv/repo\\name'
    const leaseDirectory = '/srv/repo\\name/.orca/heimdall/lease'
    const key = makeWorkspaceKey('ssh:host-a', workspacePath)
    const store = new HostRoutedLeaseStore({
      resolveTarget: async () => remoteTarget(fs, workspacePath)
    })

    await expect(store.acquireOrRenew(key, 'owner', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 1
    })
    expect(fs.directories.has(leaseDirectory)).toBe(true)
  })

  it('strips only the command newline from a remote absolute git directory', async () => {
    const fs = new MemoryFilesystem()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: requireRuntimeGitProvider only calls exec() on this provider; the rest of SshGitProvider's large surface is unused here.
    registerSshGitProvider(GIT_TEST_HOST, {
      exec: vi.fn(async () => ({
        stdout: '/srv/repo/.git \n',
        stderr: ''
      }))
    } as unknown as SshGitProvider)
    const workspacePath = '/srv/repo'
    const executionHostId = `ssh:${GIT_TEST_HOST}` as const
    const key = makeWorkspaceKey(executionHostId, workspacePath)
    const store = new HostRoutedLeaseStore({
      resolveTarget: async () => ({
        kind: 'git',
        executionHostId,
        workspacePath,
        watcherId: 'watcher-1',
        fileProvider: fs.asProvider(),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only executionHostId is read on this route; the full Worktree/GitWorktreeInfo shape is unused here.
        gitTarget: {
          executionHostId,
          worktree: { id: 'worktree-1', path: workspacePath }
        } as unknown as RuntimeGitTarget
      })
    })

    await expect(store.acquireOrRenew(key, 'owner', 90_000)).resolves.toMatchObject({
      status: 'held',
      epoch: 1
    })
    expect(fs.directories.has('/srv/repo/.git /orca-heimdall/lease')).toBe(true)
  })

  it('describes only cached lease locations and never resolves a cold route', async () => {
    const fs = new MemoryFilesystem()
    const key = makeWorkspaceKey('ssh:host-a', '/workspace')
    const resolveTarget = vi.fn(async () => remoteTarget(fs))
    const store = new HostRoutedLeaseStore({ resolveTarget })

    expect(store.describeLocation(key)).toBeNull()
    expect(resolveTarget).not.toHaveBeenCalled()

    await store.acquireOrRenew(key, 'owner', 90_000)
    expect(store.describeLocation(key)).toEqual({
      executionHostId: 'ssh:host-a',
      leaseDirectory: '/workspace/.orca/heimdall/lease',
      pathSeparator: '/'
    })
    expect(resolveTarget).toHaveBeenCalledOnce()
  })

  it('routes local folder leases through node fs only when the route provider is null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heimdall-lease-'))
    temporaryPaths.push(root)
    const key = makeWorkspaceKey('local', root)
    const store = new HostRoutedLeaseStore({
      resolveTarget: async () => ({
        kind: 'folder',
        executionHostId: 'local',
        workspacePath: root,
        watcherId: 'watcher-local',
        fileProvider: null
      })
    })
    const result = await store.acquireOrRenew(key, 'owner', 90_000)
    expect(result.status).toBe('held')
  })
})
