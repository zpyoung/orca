import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_PASSWORD_METHODS } from './artifact-password-methods'
import { DESKTOP_RENDERER_CLIENT_ID } from './artifact-password-local-caller'
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
    'blocks all password operations from paired %s clients',
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
          method.handler(
            params,
            { runtime, clientKind, clientId: 'paired-device-token' } as never,
            (() => {}) as never
          )
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

  // Why: the desktop renderer dispatches every RPC as clientKind 'runtime', so a clientKind-only
  // gate rejects the whole desktop UI and leaves the CLI as the feature's only caller.
  it('admits the desktop renderer and in-process CLI callers', () => {
    const runtime = {
      getPublishedArtifactLink: vi.fn().mockResolvedValue({ status: 'ok', value: null }),
      publishArtifact: vi.fn().mockResolvedValue({ status: 'ok', value: null }),
      shareArtifact: vi.fn().mockResolvedValue({ status: 'ok', value: null })
    }
    const callers = [
      { clientKind: undefined },
      { clientKind: 'runtime' as const, clientId: DESKTOP_RENDERER_CLIENT_ID }
    ]
    for (const caller of callers) {
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
          method.handler(params, { runtime, ...caller } as never, (() => {}) as never)
        ).not.toThrow()
      }
    }
  })

})
