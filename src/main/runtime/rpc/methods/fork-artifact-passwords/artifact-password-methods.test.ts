import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_PASSWORD_METHODS } from './artifact-password-methods'
import { WriteRequest } from '../artifacts'

const validRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Report</h1>',
  contentType: 'text/html',
  fileName: 'report.html'
}

function schema(name: string) {
  const method = ARTIFACT_PASSWORD_METHODS.find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Missing ${name}`)
  }
  return method.params
}

describe('artifact password RPC methods', () => {
  it('uses distinct methods so an old runtime cannot silently publish plaintext', () => {
    expect(ARTIFACT_PASSWORD_METHODS.map(({ name }) => name)).toEqual([
      'artifacts.shareProtected',
      'artifacts.publishProtected',
      'artifacts.rotateProtection',
      'artifacts.removeProtection',
      'artifacts.revealPassphrase'
    ])
  })

  it('accepts ordinary write fields but rejects client-supplied protection data', () => {
    expect(schema('artifacts.publishProtected').safeParse(validRequest).success).toBe(true)
    expect(
      schema('artifacts.publishProtected').safeParse({
        ...validRequest,
        protection: { mode: 'protect', passphrase: 'leak' }
      }).success
    ).toBe(false)
  })
  it.each(['mobile', 'runtime'] as const)(
    'blocks all password operations from %s clients',
    (clientKind) => {
      const runtime = {
        getPublishedArtifactLink: vi.fn(),
        publishArtifact: vi.fn(),
        shareArtifact: vi.fn()
      }
      for (const method of ARTIFACT_PASSWORD_METHODS) {
        const params =
          method.name === 'artifacts.revealPassphrase'
            ? { sourceKey: '/repo/report.html' }
            : {
                sourceKey: '/repo/report.html',
                content: '<h1>secret</h1>',
                contentType: 'text/html' as const,
                fileName: 'report.html'
              }
        expect(() =>
          method.handler(params, { runtime, clientKind } as never, (() => {}) as never)
        ).toThrow(/local Orca desktop and CLI/)
      }
      expect(runtime.getPublishedArtifactLink).not.toHaveBeenCalled()
      expect(runtime.publishArtifact).not.toHaveBeenCalled()
      expect(runtime.shareArtifact).not.toHaveBeenCalled()
    }
  )

  it('rejects protection on legacy artifact write methods', () => {
    expect(
      WriteRequest.safeParse({
        sourceKey: '/repo/report.html',
        content: '<h1>secret</h1>',
        contentType: 'text/html',
        fileName: 'report.html',
        protection: { mode: 'protect' }
      }).success
    ).toBe(false)
  })
})
