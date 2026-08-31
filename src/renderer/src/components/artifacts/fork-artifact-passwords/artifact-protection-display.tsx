import { LockKeyhole } from 'lucide-react'
import type { ArtifactListItem } from '../../../../../shared/artifacts'
import type { ArtifactProtectionState } from '../../../../../shared/fork-artifact-passwords/artifact-password-types'
import { translate } from '@/i18n/i18n'
import { TooltipContent } from '@/components/ui/tooltip'

export function artifactProtectionState(
  item: ArtifactListItem
): ArtifactProtectionState | undefined {
  return item.local?.protection ?? item.protection?.state
}

export function artifactLinkAudienceLabel(item: ArtifactListItem): string {
  const state = artifactProtectionState(item)
  if (state === 'protected-available' || state === 'protected-unavailable') {
    return translate(
      'auto.components.artifacts.artifactProtectionDisplay.encryptedLink',
      'Anyone with this link can download the encrypted file. The passphrase is required to read it.'
    )
  }
  if (state === 'unknown') {
    return translate(
      'auto.components.artifacts.artifactProtectionDisplay.unknownLink',
      'Protection status is unknown on this device.'
    )
  }
  return translate(
    'auto.components.artifacts.ArtifactDetailHeader.publicLink',
    'Anyone with this link can view it'
  )
}

export function ArtifactLinkAudience({ item }: { item: ArtifactListItem }): React.JSX.Element {
  const label = artifactLinkAudienceLabel(item)
  return (
    <>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
      <span className="sr-only">{label}</span>
    </>
  )
}

export function ArtifactNameWithProtection({
  item,
  name
}: {
  item: ArtifactListItem
  name: string
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 font-medium" title={name}>
      <span className="min-w-0 truncate">{name}</span>
      <ArtifactProtectionBadge item={item} />
    </span>
  )
}

export function ArtifactProtectionBadge({
  item
}: {
  item: ArtifactListItem
}): React.JSX.Element | null {
  const state = artifactProtectionState(item)
  if (!state || state === 'unprotected') {
    return null
  }
  const label =
    state === 'unknown'
      ? translate(
          'auto.components.artifacts.artifactProtectionDisplay.unknown',
          'Protection unknown'
        )
      : translate('auto.components.artifacts.artifactProtectionDisplay.protected', 'Protected')
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <LockKeyhole className="size-3" aria-hidden="true" />
      {label}
    </span>
  )
}
