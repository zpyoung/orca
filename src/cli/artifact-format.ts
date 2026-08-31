import type { ArtifactListItem, ArtifactListPage } from '../shared/artifacts'
import {
  formatArtifactListRowWithPassword,
  formatArtifactSharedWithPassword
} from './fork-artifact-passwords/artifact-password-cli'

export function formatArtifactList(artifacts: readonly ArtifactListItem[]): string {
  if (artifacts.length === 0) {
    return 'No shared artifacts.'
  }
  return artifacts.map(formatArtifactListRowWithPassword).join('\n\n')
}

export function formatArtifactListPage(page: ArtifactListPage): string {
  const rows = formatArtifactList(page.artifacts)
  return page.nextCursor ? `${rows}\nMore artifacts: --cursor ${page.nextCursor}` : rows
}

export function formatArtifactShared(item: ArtifactListItem): string {
  return formatArtifactSharedWithPassword(item)
}
