import { createHash, randomBytes } from 'node:crypto'
import type { CoordinatorIdentity } from '../../../shared/fork-heimdall/watcher-types'

export type { CoordinatorIdentity } from '../../../shared/fork-heimdall/watcher-types'

const randomOpaqueId = (prefix: string): string =>
  `${prefix}_${randomBytes(24).toString('base64url')}`

export function mintCoordinatorIdentity(watcherId: string): CoordinatorIdentity {
  if (!watcherId.trim()) {
    throw new Error('watcherId must be non-empty')
  }
  return {
    handle: randomOpaqueId('heimdall-coordinator'),
    paneKey: randomOpaqueId('heimdall-pane')
  }
}

export function coordinatorIdentityFingerprint(identity: CoordinatorIdentity): string {
  if (!identity.handle.trim() || !identity.paneKey.trim()) {
    throw new Error('Coordinator identity must contain a handle and paneKey')
  }
  return createHash('sha256')
    .update('heimdall-coordinator-v1\0')
    .update(identity.handle)
    .update('\0')
    .update(identity.paneKey)
    .digest('hex')
}
