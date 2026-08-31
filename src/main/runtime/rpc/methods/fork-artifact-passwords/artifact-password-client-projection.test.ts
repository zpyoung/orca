import { describe, expect, it } from 'vitest'
import type { ArtifactCloudOperation, ArtifactListPage } from '../../../../../shared/artifacts'
import { projectArtifactListForClient } from './artifact-password-client-projection'

const page: ArtifactCloudOperation<ArtifactListPage> = {
  status: 'ok',
  value: {
    artifacts: [
      {
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
        shareUrl: 'https://share.onorca.dev/a/artifact-a',
        local: {
          sourceKey: '/secret/report.html',
          displayName: 'report.html',
          sourceContentType: 'text/html',
          protection: 'protected-available'
        },
        protection: { state: 'unknown' }
      }
    ]
  }
}

describe('artifact password client projection', () => {
  it.each(['mobile', 'runtime'] as const)('removes local fields for %s clients', (clientKind) => {
    const item = page.status === 'ok' ? page.value.artifacts[0] : undefined
    expect(projectArtifactListForClient(page, clientKind)).toEqual({
      status: 'ok',
      value: {
        artifacts: [
          {
            artifact: item?.artifact,
            shareUrl: item?.shareUrl,
            protection: { state: 'unknown' }
          }
        ]
      }
    })
  })

  it('keeps local fields for local desktop and CLI callers', () => {
    expect(projectArtifactListForClient(page, undefined)).toBe(page)
  })

  it('preserves auth failures without projecting them', () => {
    const reconnectRequired = { status: 'reconnect-required' } as const
    expect(projectArtifactListForClient(reconnectRequired, 'mobile')).toBe(reconnectRequired)
  })
})
