import { describe, expect, it } from 'vitest'
import type { ArtifactCloudOperation, ArtifactListPage } from '../../../../../shared/artifacts'
import {
  projectArtifactListForClient,
  projectListItemForClient,
  projectPublishResultForClient,
  projectPublishedLinkForClient,
  withArtifactProtectionProjection
} from './artifact-password-client-projection'
import { DESKTOP_RENDERER_CLIENT_ID } from './artifact-password-local-caller'

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
    expect(projectArtifactListForClient(page, { clientKind, clientId: 'paired-device-token' })).toEqual({
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

  it('keeps local fields for in-process CLI callers', () => {
    expect(projectArtifactListForClient(page, { clientKind: undefined })).toBe(page)
  })

  // Why: the desktop renderer dispatches as 'runtime' like a paired desktop client; only its
  // clientId separates them, and projecting it would blank the whole artifacts page.
  it('keeps local fields for the desktop renderer', () => {
    expect(
      projectArtifactListForClient(page, {
        clientKind: 'runtime',
        clientId: DESKTOP_RENDERER_CLIENT_ID
      })
    ).toBe(page)
  })

  it('preserves auth failures without projecting them', () => {
    const reconnectRequired = { status: 'reconnect-required' } as const
    expect(projectArtifactListForClient(reconnectRequired, { clientKind: 'mobile' })).toBe(
      reconnectRequired
    )
  })
})

describe('artifact protection projection on single results', () => {
  const paired = { clientKind: 'runtime' as const, clientId: 'paired-device-token' }
  const local = { clientKind: 'runtime' as const, clientId: DESKTOP_RENDERER_CLIENT_ID }
  const item = {
    artifact: { id: 'a1' },
    shareUrl: 'https://share.example/a1',
    local: { sourceKey: '/repo/secret.html', displayName: 'secret.html' },
    protection: { state: 'protected-available' as const }
  } as never

  // Why: getPublishedLink carries rotationCleanupPending, the one protection detail that leaks
  // an in-flight rotation to a paired client.
  it('collapses published-link protection for paired clients', () => {
    const operation = {
      status: 'ok' as const,
      value: {
        shareUrl: 'https://share.example/a1',
        protection: { state: 'protected-available' as const, rotationCleanupPending: true }
      }
    }
    expect(projectPublishedLinkForClient(operation as never, paired)).toEqual({
      status: 'ok',
      value: { shareUrl: 'https://share.example/a1', protection: { state: 'unknown' } }
    })
    expect(projectPublishedLinkForClient(operation as never, local)).toBe(operation)
  })

  it('strips local overlays from share and update results', () => {
    const operation = { status: 'ok' as const, value: item }
    expect(projectListItemForClient(operation, paired)).toEqual({
      status: 'ok',
      value: {
        artifact: { id: 'a1' },
        shareUrl: 'https://share.example/a1',
        protection: { state: 'unknown' }
      }
    })
    expect(projectListItemForClient(operation, local)).toBe(operation)
  })

  it('strips local overlays from publish results', () => {
    const operation = {
      status: 'ok' as const,
      value: { change: 'created' as const, item, protection: { state: 'protected-available' } }
    }
    expect(projectPublishResultForClient(operation as never, paired)).toEqual({
      status: 'ok',
      value: {
        change: 'created',
        item: {
          artifact: { id: 'a1' },
          shareUrl: 'https://share.example/a1',
          protection: { state: 'unknown' }
        },
        protection: { state: 'unknown' }
      }
    })
  })
})

describe('withArtifactProtectionProjection', () => {
  it('projects every artifact method that can carry protection state', async () => {
    const methods = [
      { name: 'artifacts.share', handler: () => ({ status: 'ok', value: { artifact: {}, shareUrl: 'u', local: { sourceKey: '/s' } } }) },
      { name: 'artifacts.delete', handler: () => ({ status: 'ok', value: { deleted: true } }) }
    ] as never[]
    type Wrapped = { handler: (params: never, context: never) => Promise<unknown> }
    const [share, remove] = withArtifactProtectionProjection(methods) as unknown as Wrapped[]
    const paired = { clientKind: 'runtime', clientId: 'paired-device-token' } as never
    expect(await share.handler({} as never, paired)).toEqual({
      status: 'ok',
      value: { artifact: {}, shareUrl: 'u', protection: { state: 'unknown' } }
    })
    // Why: an unprojected method must pass through untouched, not be wrapped into a promise trap.
    expect(await remove.handler({} as never, paired)).toEqual({
      status: 'ok',
      value: { deleted: true }
    })
  })
})
