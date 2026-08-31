// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem, ArtifactPublishResult } from '../../../../../shared/artifacts'
import { ArtifactPasswordPanel } from './ArtifactPasswordPanel'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  publish: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('../artifact-publish-flow', () => ({ publishArtifactFromSurface: mocks.publish }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'artifact-a',
    title: 'Protected Orca artifact',
    originalFileName: 'Protected Orca artifact.html',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-09-28T00:00:00.000Z',
    byteSize: 100,
    deletedAt: null
  },
  shareUrl: 'https://share.onorca.dev/a/artifact-a'
}

const published: ArtifactPublishResult = {
  change: 'created',
  item,
  protection: {
    state: 'protected-available',
    passphrase: 'abacus abdomen abdominal abide abiding ability'
  }
}

afterEach(cleanup)

beforeEach(() => {
  mocks.callRuntimeRpc.mockReset()
  mocks.publish.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
  })
})

describe('ArtifactPasswordPanel', () => {
  it('uses the protected RPC and shows a separate passphrase copy control', async () => {
    mocks.publish.mockResolvedValue(published)
    const createRequest = vi.fn()
    const onPublished = vi.fn()
    render(
      <ArtifactPasswordPanel
        sourceKey="/repo/report.html"
        createRequest={createRequest}
        shareUrl={null}
        disabled={false}
        onPublished={onPublished}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Share protected link' }))

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith(createRequest, 'artifacts.publishProtected')
    )
    expect(onPublished).toHaveBeenCalledWith(published)
    expect(screen.getByLabelText('Artifact passphrase')).toHaveValue(
      published.protection?.passphrase
    )
    expect(screen.getByRole('button', { name: 'Copy passphrase' })).toBeVisible()
  })

  it('does not reveal an existing passphrase until the user asks', async () => {
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({
        status: 'ok',
        value: { shareUrl: item.shareUrl, protection: { state: 'protected-available' } }
      })
      .mockResolvedValueOnce({
        status: 'ok',
        value: {
          shareUrl: item.shareUrl,
          protection: {
            state: 'protected-available',
            passphrase: published.protection?.passphrase
          }
        }
      })
    render(
      <ArtifactPasswordPanel
        sourceKey="/repo/report.html"
        createRequest={vi.fn()}
        shareUrl={item.shareUrl}
        disabled={false}
        onPublished={vi.fn()}
      />
    )

    const reveal = await screen.findByRole('button', { name: 'Reveal passphrase' })
    expect(screen.queryByLabelText('Artifact passphrase')).toBeNull()
    fireEvent.click(reveal)

    expect(await screen.findByLabelText('Artifact passphrase')).toHaveValue(
      published.protection?.passphrase
    )
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'artifacts.revealPassphrase',
      { sourceKey: '/repo/report.html' }
    )
  })
})
