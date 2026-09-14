import { describe, expect, it } from 'vitest'
import { coordinatorIdentityFingerprint, mintCoordinatorIdentity } from './coordinator-identity'

describe('Heimdall coordinator identity', () => {
  it('mints opaque unique handle and pane values for every watcher', () => {
    const first = mintCoordinatorIdentity('watcher-1')
    const second = mintCoordinatorIdentity('watcher-2')

    expect(first.handle).not.toBe(first.paneKey)
    expect(first.handle).not.toBe(second.handle)
    expect(first.paneKey).not.toBe(second.paneKey)
    expect(first.handle).not.toContain('watcher-1')
    expect(first.paneKey).not.toContain('watcher-1')
  })

  it('derives a stable mutation caller fingerprint from the persisted identity', () => {
    const persisted = mintCoordinatorIdentity('watcher-1')
    const restored = JSON.parse(JSON.stringify(persisted)) as typeof persisted

    expect(coordinatorIdentityFingerprint(restored)).toBe(coordinatorIdentityFingerprint(persisted))
    expect(
      coordinatorIdentityFingerprint({
        ...restored,
        paneKey: mintCoordinatorIdentity('other').paneKey
      })
    ).not.toBe(coordinatorIdentityFingerprint(persisted))
  })

  it('rejects empty watcher ids rather than minting an unowned coordinator', () => {
    expect(() => mintCoordinatorIdentity('')).toThrow('watcherId')
    expect(() => mintCoordinatorIdentity('   ')).toThrow('watcherId')
  })
})
