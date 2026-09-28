import { VirtualizedList } from '@/components/virtualized-list'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { isPortaledRowMenuClick, isRowActivationKey } from '@/lib/list-row-interaction'
import {
  artifactName,
  artifactTypeLabel,
  formatArtifactExpiryCompact,
  formatArtifactUpdatedCompact,
  formatByteSize
} from './artifact-display-labels'
import { copyArtifactLink, openArtifactInBrowser } from './artifact-link-actions'
import { ARTIFACTS_TABLE_GRID_CLASS } from './artifacts-table-layout'
import { LIST_TABLE_ROW_CLASS, LIST_TABLE_ROW_SELECTED_CLASS } from '@/lib/list-table-layout'
import { ArtifactNameWithProtection } from './fork-artifact-passwords/artifact-protection-display'

type ArtifactRowAction = {
  key: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Rendered after a separator, styled as destructive. */
  destructive?: boolean
  disabled?: boolean
}

// Why: the row dropdown and the row context menu must offer the same actions; one source keeps them from drifting.
function artifactRowActions(
  item: ArtifactListItem,
  deleting: boolean,
  deleteArtifact: (item: ArtifactListItem) => void
): readonly ArtifactRowAction[] {
  return [
    {
      key: 'copy',
      label: translate('auto.components.artifacts.copyLink', 'Copy link'),
      icon: Copy,
      onSelect: () => void copyArtifactLink(item.shareUrl)
    },
    {
      key: 'open',
      label: translate('auto.components.artifacts.openInBrowser', 'Open in browser'),
      icon: ExternalLink,
      onSelect: () => openArtifactInBrowser(item.shareUrl)
    },
    {
      key: 'delete',
      label: translate('auto.components.artifacts.ArtifactsPage.deleteArtifact', 'Delete artifact'),
      icon: Trash2,
      onSelect: () => deleteArtifact(item),
      destructive: true,
      disabled: deleting
    }
  ]
}

/**
 * The artifacts table body, windowed inside the collection's scroller. Load more only appends, so
 * between refreshes the list grows without bound; below the virtualize threshold rows stay in
 * natural flow.
 */
export function ArtifactListRows({
  artifacts,
  deletingId,
  selectedSlug,
  scrollElement,
  hasMore,
  selectArtifact,
  deleteArtifact
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  scrollElement: HTMLDivElement | null
  // Why it has to reach the rows: the cursor is what makes the loaded count not the real total, so
  // without it every row would announce a set size the Load more button next to it contradicts.
  hasMore: boolean
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
}): React.JSX.Element {
  // Why: appended pages are deduped against the slugs already loaded, and the first page's are
  // unique per the server, so a slug identifies the last row without an index — which `renderRow`
  // does not supply.
  const lastSlug = artifacts.at(-1)?.artifact.slug

        return (
          <ContextMenu key={item.artifact.slug}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-current={isSelected ? 'true' : undefined}
                onClick={(event) => {
                  if (isPortaledRowMenuClick(event)) {
                    return
                  }
                  selectArtifact(item.artifact.slug)
                }}
                onKeyDown={(event) => {
                  if (!isRowActivationKey(event)) {
                    return
                  }
                  event.preventDefault()
                  selectArtifact(item.artifact.slug)
                }}
                className={cn(
                  ARTIFACTS_TABLE_GRID_CLASS,
                  LIST_TABLE_ROW_CLASS,
                  isSelected && LIST_TABLE_ROW_SELECTED_CLASS
                )}
              >
                <ArtifactNameWithProtection item={item} name={name} />
                <span className="min-w-0 truncate text-muted-foreground" title={typeLabel}>
                  {typeLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={sizeLabel}>
                  {sizeLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={updatedLabel}>
                  {updatedLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={expiryLabel}>
                  {expiryLabel}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-7 text-muted-foreground"
                      aria-label={translate(
                        'auto.components.artifacts.actions',
                        'Artifact actions'
                      )}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    {rowActions.map(
                      ({ key, label, icon: Icon, onSelect, destructive, disabled }) => (
                        <Fragment key={key}>
                          {destructive ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuItem
                            variant={destructive ? 'destructive' : 'default'}
                            disabled={disabled}
                            onSelect={onSelect}
                          >
                            <Icon className="size-3.5" />
                            {label}
                          </DropdownMenuItem>
                        </Fragment>
                      )
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              {rowActions.map(({ key, label, icon: Icon, onSelect, destructive, disabled }) => (
                <Fragment key={key}>
                  {destructive ? <ContextMenuSeparator /> : null}
                  <ContextMenuItem
                    variant={destructive ? 'destructive' : 'default'}
                    disabled={disabled}
                    onSelect={onSelect}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </ContextMenuItem>
                </Fragment>
              ))}
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </>
  )
}
