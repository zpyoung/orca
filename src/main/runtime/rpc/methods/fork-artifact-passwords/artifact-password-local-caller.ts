/**
 * Identifies RPC callers that run on the device owning the artifact passphrase keychain.
 *
 * Passphrase operations and local artifact overlays terminate here rather than crossing the
 * relay, so every gate in this feature asks this module rather than reading `clientKind`
 * directly.
 */

/**
 * The `clientId` the desktop main frame's IPC bridge stamps on every renderer RPC.
 *
 * Upstream sets this in `src/main/ipc/runtime.ts`. A paired device's `clientId` is its
 * registry-issued token — 48 lowercase hex characters — so no paired caller can present this
 * value. `artifact-password-local-caller.test.ts` pins both halves of that argument.
 */
export const DESKTOP_RENDERER_CLIENT_ID = 'desktop-renderer'

export type ArtifactPasswordCaller = {
  clientKind: 'mobile' | 'runtime' | undefined
  clientId?: string
}

/**
 * True when the caller holds this device's passphrase records: an in-process caller (the CLI
 * and startup recovery dispatch with no `clientKind`) or the desktop renderer's main frame.
 *
 * The desktop renderer dispatches as `clientKind: 'runtime'`, the same kind a paired desktop or
 * web client carries, so `clientKind` alone cannot separate them — gating on it locks the whole
 * desktop UI out of its own feature.
 */
export function isLocalArtifactPasswordCaller(caller: ArtifactPasswordCaller): boolean {
  if (caller.clientKind === undefined) {
    return true
  }
  return caller.clientKind === 'runtime' && caller.clientId === DESKTOP_RENDERER_CLIENT_ID
}
