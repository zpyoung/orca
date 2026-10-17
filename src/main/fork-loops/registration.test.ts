import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { validateLoopCheckHost } from './loop-check'
import { resolveLoopTargets } from './registration'

const sshState = vi.hoisted(() => {
  const state: { platform: string | undefined } = { platform: undefined }
  return state
})

vi.mock('../ssh/ssh-target-registry', () => ({
  getRegisteredSshState: vi.fn(() => ({ remotePlatform: sshState.platform }))
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(() => ({}))
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn(() => undefined)
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
