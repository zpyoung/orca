// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  state: {
    orcaProfileAuthStatus: { state: 'connected' },
    connectCurrentOrcaProfile: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

import { publishArtifactFromSurface } from '../artifact-publish-flow'

const request = {
  sourceKey: '/repo/report.html',
  content: '<h1>secret</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('protected artifact publish feedback', () => {
  it('does not claim success while old-link rotation cleanup is incomplete', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      status: 'ok',
      value: {
        change: 'created',
        item: { shareUrl: 'https://share.onorca.dev/a/new' },
        protection: {
          state: 'protected-available',
          rotationCleanupPending: true
        }
      }
    })

    await expect(
      publishArtifactFromSurface(() => Promise.resolve(request), 'artifacts.rotateProtection')
    ).resolves.toMatchObject({ protection: { rotationCleanupPending: true } })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
