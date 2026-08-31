export const ARTIFACT_PROTECTED_PAGE_MAX_BYTES = 800 * 1024
export const ARTIFACT_PASSWORD_PBKDF2_ITERATIONS = 600_000
export const ARTIFACT_PASSWORD_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024
export const ARTIFACT_PASSWORD_NEUTRAL_NAME = 'Protected Orca artifact'

export type ArtifactProtectionRequest =
  | { mode: 'protect' }
  | { mode: 'rotate' }
  | { mode: 'remove' }

export type ArtifactProtectionState =
  | 'unknown'
  | 'unprotected'
  | 'protected-available'
  | 'protected-unavailable'

export type ArtifactProtectionPublication = {
  state: ArtifactProtectionState
  passphrase?: string
  rotationCleanupPending?: boolean
}

export type ArtifactLocalDetails = {
  displayName: string
  sourceContentType: 'text/html' | 'text/markdown'
  sourceKey: string
  protection: Exclude<ArtifactProtectionState, 'unprotected'>
}

export type ArtifactPublishedProtection = {
  state: ArtifactProtectionState
  passphrase?: string
  rotationCleanupPending?: boolean
}

/** Canonicalizes recipient input identically in main and the public unlock page. */
export function normalizeArtifactPassphrase(value: string): string {
  const normalized = value.normalize('NFKC').trim()
  if (!normalized) {
    throw new Error('Passphrase cannot be empty.')
  }
  if ([...normalized].length > 256) {
    throw new Error('Passphrase must be 256 characters or fewer.')
  }
  return normalized
}
