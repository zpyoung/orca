import type { ArtifactListItem } from '../../shared/artifacts'

/** Selects the fail-closed protected RPC when the CLI protection flag is present. */
export function artifactShareRpcMethod(flags: ReadonlyMap<string, string | boolean>): string {
  return flags.has('protect') ? 'artifacts.shareProtected' : 'artifacts.share'
}

/** Formats one CLI list row using local protected metadata when available. */
export function formatArtifactListRowWithPassword(item: ArtifactListItem): string {
  const { artifact, shareUrl } = item
  const name =
    item.local?.displayName || artifact.title || artifact.originalFileName || artifact.slug
  return `${name}\n  id: ${artifact.slug}\n  updated: ${artifact.updatedAt}\n  url: ${shareUrl}`
}

/** Formats a protected result with separate link and passphrase sections. */
export function formatArtifactSharedWithPassword(item: ArtifactListItem): string {
  const passphrase = item.protection?.passphrase
  return passphrase
    ? `${item.shareUrl}
Passphrase: ${passphrase}
Send the link and passphrase separately. The passphrase is also visible in this terminal output.`
    : item.shareUrl
}
