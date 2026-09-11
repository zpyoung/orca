import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactPasswordRecordStore } from './artifact-password-record-store'

const mocks = vi.hoisted(() => ({ getArtifactCreateIntent: vi.fn() }))

vi.mock('../artifact-create-intent-store', () => ({
  getArtifactCreateIntent: mocks.getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent: vi.fn(),
  removeArtifactCreateIntent: vi.fn()
}))

import { ArtifactPasswordRemovalCoordinator } from './artifact-password-removal'

const scope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://share.onorca.dev'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getArtifactCreateIntent.mockReturnValue(null)
})

describe('protected removal phase recovery', () => {
  it('cleans an applied removal before a later update can re-encrypt it', async () => {
    const records = {
      getCurrent: vi.fn(() => ({ removalState: 'applied' })),
      remove: vi.fn()
    } as unknown as ArtifactPasswordRecordStore
    const execute = vi.fn()
    const coordinator = new ArtifactPasswordRemovalCoordinator('/profiles', records)

    await coordinator.retryWithExecute(
      '/repo/report.html',
      { profileId: 'profile-a', scope, assertCurrent: vi.fn() },
      execute
    )

    expect(execute).not.toHaveBeenCalled()
    expect(records.remove).toHaveBeenCalledWith('profile-a', scope, {
      sourceKey: '/repo/report.html'
    })
  })

  it('fails closed when a pending phase has lost its durable request', async () => {
    const records = {
      getCurrent: vi.fn(() => ({ removalState: 'pending' })),
      remove: vi.fn()
    } as unknown as ArtifactPasswordRecordStore
    const coordinator = new ArtifactPasswordRemovalCoordinator('/profiles', records)

    await expect(
      coordinator.retryWithExecute(
        '/repo/report.html',
        { profileId: 'profile-a', scope, assertCurrent: vi.fn() },
        vi.fn()
      )
    ).rejects.toThrow(/journal is incomplete/)
  })
})
