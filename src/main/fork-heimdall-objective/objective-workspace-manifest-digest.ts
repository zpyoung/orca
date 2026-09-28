import { createHash } from 'node:crypto'

export type ObjectiveWorkspaceManifestEntry = { path: string; fingerprint: string }

export function objectiveWorkspaceManifestDigest(
  manifest: readonly ObjectiveWorkspaceManifestEntry[]
): string {
  const hash = createHash('sha256')
  for (const entry of manifest) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.fingerprint)
    hash.update('\0')
  }
  return hash.digest('hex')
}
