import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').replace('encrypted:', '')
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

const definition: HostedReviewSitterDefinition = {
  id: 'sitter-1',
  enabled: true,
  repoId: 'repo-1',
  worktreeId: 'repo-1::/tmp/repo-1',
  repoPath: '/tmp/repo-1',
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  capabilities: {
    updateBranch: 'on',
    resolveConflicts: 'gated',
    fixChecks: 'on',
    merge: 'gated'
  },
  activeBudgetMs: 3_600_000,
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
}

describe('hosted review sitter definition persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-review-sitter-store-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('round-trips definitions through the real Store durable snapshot', async () => {
    vi.resetModules()
    // Import after resetting modules so Store observes this test's isolated Electron profile mock.
    const { Store } = await import('../persistence')
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = new Store({ dataFile })

    store.replaceHostedReviewSitterDefinitionsAndFlush([definition])

    const reloaded = new Store({ dataFile })
    expect(reloaded.getHostedReviewSitterDefinitions()).toEqual([definition])
  })
})
