import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { resolveLoopTargets } from './registration'

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
  // this process serves no ssh: provider; a managed remote host runs its own loop service
  it('refuses an ssh: host with the not-served error', async () => {
    const targets = resolveLoopTargets(runtime, store, 'repo-1::/work')
    await expect(targets).rejects.toBeInstanceOf(SshHostNotServedError)
    await expect(targets).rejects.toMatchObject({ connectionId: 'target-1' })
  })
})
