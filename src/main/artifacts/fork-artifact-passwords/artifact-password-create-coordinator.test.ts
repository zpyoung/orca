import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../shared/artifacts'
import type { ArtifactPasswordRecordStore } from './artifact-password-record-store'

const mocks = vi.hoisted(() => ({
  artifactRequest: vi.fn(),
  getArtifactCreateIntent: vi.fn(),
  getArtifactShareRecord: vi.fn(),
  removeArtifactCreateIntent: vi.fn()
}))

vi.mock('../artifact-cloud-request', () => ({
  artifactRequest: mocks.artifactRequest,
  artifactWriteBody: (request: Record<string, unknown>) => ({
    content: request.content,
    contentType: request.contentType,
    fileName: request.fileName,
    title: request.title
  })
}))
vi.mock('../artifact-create-intent-store', () => ({
  getArtifactCreateIntent: mocks.getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent: vi.fn(),
  removeArtifactCreateIntent: mocks.removeArtifactCreateIntent
}))
vi.mock('../artifact-share-record-store', () => ({
  getArtifactShareRecord: mocks.getArtifactShareRecord,
  saveArtifactShareRecord: vi.fn()
}))

import { ArtifactPasswordCreateCoordinator } from './artifact-password-create-coordinator'

const scope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://share.onorca.dev'
}
const request = {
  sourceKey: '/repo/report.html',
  content: '<html>encrypted page</html>',
  contentType: 'text/html' as const,
  fileName: 'Protected Orca artifact',
  title: 'Protected Orca artifact'
}
const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'artifact-a',
    title: 'Protected Orca artifact',
    originalFileName: 'Protected Orca artifact',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    byteSize: 100,
    deletedAt: null
  },
  shareUrl: 'https://share.onorca.dev/a/artifact-a'
}

function createRecords(): ArtifactPasswordRecordStore {
  return {
    getCurrent: vi.fn(() => ({
      sourceKey: request.sourceKey,
      slug: 'artifact-a',
      displayName: 'report.html',
      sourceContentType: 'text/html',
      expiresAt: item.artifact.expiresAt,
      passphrase: 'six generated words remain available',
      completedCreateIntentId: 'intent-a'
    })),
    rebindCurrent: vi.fn()
  } as unknown as ArtifactPasswordRecordStore
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getArtifactShareRecord.mockReturnValue({ slug: 'artifact-a', editToken: 'edit-a' })
  mocks.artifactRequest.mockResolvedValue(item)
})

describe('protected create response recovery', () => {
  it('cleans a committed intent and reconstructs the lost share response', async () => {
    const intent = {
      idempotencyKey: 'intent-a',
      body: {
        content: request.content,
        contentType: request.contentType,
        fileName: request.fileName,
        title: request.title
      }
    }
    mocks.getArtifactCreateIntent.mockReturnValue(intent)
    const records = createRecords()
    const coordinator = new ArtifactPasswordCreateCoordinator('/profiles', records)

    await expect(
      coordinator.recoverCommitted(request, 'token', scope.apiOrigin, {
        profileId: 'profile-a',
        scope,
        assertCurrent: vi.fn()
      })
    ).resolves.toBe(item)
    expect(mocks.artifactRequest).toHaveBeenCalledWith(scope.apiOrigin, 'token', '/artifact-a', {
      editToken: 'edit-a'
    })
    expect(mocks.removeArtifactCreateIntent).toHaveBeenCalledWith(
      'profile-a',
      '/profiles',
      JSON.stringify(['artifact-password', request.sourceKey]),
      scope,
      'intent-a'
    )
  })

  it('replays edited content when the interrupted create left its intent behind', async () => {
    mocks.getArtifactCreateIntent.mockReturnValue({
      idempotencyKey: 'intent-a',
      body: { ...request, content: '<html>superseded page</html>' }
    })
    const coordinator = new ArtifactPasswordCreateCoordinator('/profiles', createRecords())

    await coordinator.recoverCommitted(request, 'token', scope.apiOrigin, {
      profileId: 'profile-a',
      scope,
      assertCurrent: vi.fn()
    })

    expect(mocks.artifactRequest).toHaveBeenCalledWith(
      scope.apiOrigin,
      'token',
      '/artifact-a',
      expect.objectContaining({ method: 'PUT' })
    )
  })

  it('declines recovery once finalization removed the intent', async () => {
    mocks.getArtifactCreateIntent.mockReturnValue(null)
    const coordinator = new ArtifactPasswordCreateCoordinator('/profiles', createRecords())

    await expect(
      coordinator.recoverCommitted(request, 'token', scope.apiOrigin, {
        profileId: 'profile-a',
        scope,
        assertCurrent: vi.fn()
      })
    ).resolves.toBeNull()
    expect(mocks.artifactRequest).not.toHaveBeenCalled()
  })
})
