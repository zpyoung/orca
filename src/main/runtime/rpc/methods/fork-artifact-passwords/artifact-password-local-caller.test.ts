import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_RENDERER_CLIENT_ID,
  isLocalArtifactPasswordCaller
} from './artifact-password-local-caller'

const REPO_ROOT = join(import.meta.dirname, '../../../../../..')

describe('artifact password local caller', () => {
  it('admits in-process callers, which dispatch without a clientKind', () => {
    expect(isLocalArtifactPasswordCaller({ clientKind: undefined })).toBe(true)
  })

  it('admits the desktop renderer', () => {
    expect(
      isLocalArtifactPasswordCaller({
        clientKind: 'runtime',
        clientId: DESKTOP_RENDERER_CLIENT_ID
      })
    ).toBe(true)
  })

  it('rejects paired runtime clients, which share the renderer clientKind', () => {
    expect(
      isLocalArtifactPasswordCaller({ clientKind: 'runtime', clientId: 'a'.repeat(48) })
    ).toBe(false)
    expect(isLocalArtifactPasswordCaller({ clientKind: 'runtime' })).toBe(false)
  })

  it('rejects paired mobile clients', () => {
    expect(
      isLocalArtifactPasswordCaller({
        clientKind: 'mobile',
        clientId: DESKTOP_RENDERER_CLIENT_ID
      })
    ).toBe(false)
  })

  // Why: the gate reads a literal upstream stamps on renderer RPCs. An upstream rename would
  // silently lock the desktop UI out again, so fail here instead of in the product.
  it('matches the clientId upstream stamps on desktop renderer RPCs', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/main/ipc/runtime.ts'), 'utf8')
    expect(source).toContain(`clientId: '${DESKTOP_RENDERER_CLIENT_ID}'`)
  })

  // Why: the gate is only sound while no paired device token can equal the renderer literal.
  // Tokens are randomBytes(24).toString('hex') — 48 lowercase hex chars, which this never is.
  it('cannot collide with a registry-issued device token', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/main/runtime/device-registry.ts'), 'utf8')
    expect(source).toContain("token: randomBytes(24).toString('hex')")
    expect(DESKTOP_RENDERER_CLIENT_ID).not.toMatch(/^[0-9a-f]{48}$/)
  })
})
