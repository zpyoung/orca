import React from 'react'

import { WorktreeCardSurface } from './worktree-card-surface'
import type { WorktreeCardProps } from './worktree-card-model'
import { useWorktreeCardController } from './use-worktree-card-controller'

export type ActiveSurfaceVariant = 'primary' | 'secondary'

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isCurrentWorktree?: boolean
  isActiveSurface?: boolean
  activeSurfaceVariant?: ActiveSurfaceVariant
  isMultiSelected?: boolean
  revealHighlight?: boolean
  revealHighlightTone?: 'default' | 'ai'
  selectedWorktrees?: readonly Worktree[]
  hideRepoBadge?: boolean
  hostContextLabel?: string
  inPinnedSection?: boolean
  inProjectGroupLooseSection?: boolean
  activationRowKey?: string
  renameRowKey?: string
  contentIndent?: number
  flushSurface?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  lineageChildren?: React.ReactNode
  lineageChildrenStyle?: React.CSSProperties
  onLineageToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void
  isLineageDropTarget?: boolean
  onActivate?: () => void
  onImmediateActivate?: (worktreeId: string, rowKey: string | undefined) => void
  onSelectionGesture?: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect?: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onCardDragStart?: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedIds: readonly string[]
  ) => void
  onCardDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void
  nativeDragEnabled?: boolean
  affiliateListMode?: boolean
  statusPrDisplay?: WorktreeCardPrDisplay | null
}

const EMPTY_WORKSPACE_PORTS = []
const HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS = 60_000

export function shouldBeginWorktreeRename(
  request: WorktreeRenameRequest | null,
  worktreeId: string,
  rowKey: string | undefined
): boolean {
  return (
    request?.worktreeId === worktreeId &&
    (request.rowKey === undefined || request.rowKey === rowKey)
  )
}

function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

function getDirectoryName(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/)
  return parts.at(-1) || normalized || folderPath
}

// Why: pinned repo icon and compact inline badge share this chip shell so both repo cues read as the same affordance.
function RepoIdentityChip({
  repo,
  children
}: {
  repo: Repo
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55"
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.35ccfe2475',
            'Project {{value0}}',
            { value0: repo.displayName }
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {repo.displayName}
      </TooltipContent>
    </Tooltip>
  )
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  isActiveSurface = isActive,
  activeSurfaceVariant = 'primary',
  isMultiSelected = false,
  revealHighlight = false,
  revealHighlightTone = 'default',
  selectedWorktrees,
  onActivate,
  onImmediateActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onAssignWorkspaceStatus,
  onCardDragStart,
  onCardDragEnd,
  nativeDragEnabled = true,
  hideRepoBadge,
  hostContextLabel,
  inPinnedSection = false,
  inProjectGroupLooseSection = false,
  activationRowKey,
  renameRowKey,
  contentIndent = 0,
  flushSurface = false,
  lineageChildCount = 0,
  lineageCollapsed = false,
  lineageChildren,
  lineageChildrenStyle,
  onLineageToggle,
  isLineageDropTarget = false,
  affiliateListMode = false,
  statusPrDisplay = null
}: WorktreeCardProps): React.JSX.Element {
  const card = useWorktreeCardController({
    worktree,
    repo,
    isActive,
    isActiveSurface,
    activeSurfaceVariant,
    isMultiSelected,
    revealHighlight,
    revealHighlightTone,
    selectedWorktrees,
    onActivate,
    onImmediateActivate,
    onSelectionGesture,
    onContextMenuSelect,
    onAssignWorkspaceStatus,
    onCardDragStart,
    onCardDragEnd,
    nativeDragEnabled,
    hideRepoBadge,
    hostContextLabel,
    inPinnedSection,
    activationRowKey,
    renameRowKey,
    contentIndent,
    flushSurface,
    lineageChildCount,
    lineageCollapsed,
    lineageChildren,
    lineageChildrenStyle,
    onLineageToggle,
    isLineageDropTarget,
    affiliateListMode,
    statusPrDisplay
  })
  const hasPorts = showPorts && workspacePorts.length > 0
  const cacheStartedAt = usePromptCacheCountdownStartedAt(worktree.id, showAggregateCacheTimer)
  const cacheTtlMs = useAppStore((s) =>
    showAggregateCacheTimer ? (s.settings?.promptCacheTtlMs ?? 0) : 0
  )
  // Why: these sections render a row away from its repo header, so origin has to come from the
  // row itself regardless of groupBy's hideRepoBadge.
  const showOriginRepoIcon = (inPinnedSection || inProjectGroupLooseSection) && !!repo
  // Why: new card style retired the Compact/Detailed switch; repo identity uses the compact chip, not a lower pill.
  const showRepoIdentityInTitle = newCardStyle || compactCards
  const showInlineRepoBadge =
    showRepoIdentityInTitle && !!repo && !hideRepoBadge && !isFolder && !showOriginRepoIcon
  const showRepoBadgeInMetaRow =
    !showRepoIdentityInTitle && !!repo && !hideRepoBadge && !showOriginRepoIcon
  const showHostContextBadge = !compactCards && !!hostContextLabel
  const showDetachedHeadInMetaRow = !compactCards && !isFolder && detachedHeadDisplay !== null
  const showBranch =
    !isFolder &&
    branch.length > 0 &&
    !newCardStyle &&
    (!compactCards || branch !== worktree.displayName)
  // Why: rebases already surface in source control, so dense cards skip the persistent rebase chip.
  const showConflictOperationBadge =
    !!conflictOperation && conflictOperation !== 'unknown' && conflictOperation !== 'rebase'
  const hasMetadataBadge = showConflictOperationBadge
  const showUnreadQuickAction = !affiliateListMode && showStatus && !newCardStyle
  // Why: the slot owns the unread/status lane; legacy keeps the bell toggle, the new card keeps the glyph passive.
  const showCombinedStatusSlot = showStatus
  const showTitleRowPrimary = compactCards && worktree.isMainWorktree && !isFolder
  const showMetaRowDetails = !newCardStyle && !compactCards && (hasDetails || hasPorts)
  const showTitleRowIndicators = (newCardStyle || compactCards) && (hasDetails || hasPorts)
  // Why: grouped views can hide the repo badge; don't reserve a blank metadata lane unless there's real content.
  const hasDetailedMetaRowContent = Boolean(
    (showRepoBadgeInMetaRow && repo) ||
    showHostContextBadge ||
    folderMetaRowContent ||
    showBranch ||
    showIdentityInNewCard ||
    showDetachedHeadInMetaRow ||
    showConflictOperationBadge ||
    cacheStartedAt != null ||
    showMetaRowDetails
  )
  const hasMetaRow = compactCards
    ? hasMetadataBadge || cacheStartedAt != null
    : hasDetailedMetaRowContent
  const showHeaderActions = showTitleRowPrimary || showDeleteQuickAction
  // Why: normalize the title once so title/branch de-dupe and identity-only hover eligibility stay in sync.
  const trimmedVisibleCardTitle = visibleCardTitle.trim()
  const showBranchIdentityHover = newCardStyle
    ? Boolean(identityDisplay) &&
      !cardProps.includes('branch') &&
      identityDisplay !== trimmedVisibleCardTitle
    : compactCards && showBranch
  const hoverBranchName = newCardStyle
    ? identityDisplay
    : showBranchIdentityHover
      ? branch
      : undefined
  const hoverWorkspaceTitle =
    trimmedVisibleCardTitle.length > 0 && trimmedVisibleCardTitle !== hoverBranchName
      ? trimmedVisibleCardTitle
      : undefined
  const hasHoverIdentity = Boolean(hoverWorkspaceTitle || hoverBranchName)
  const hasHoverDetails =
    newCardStyle &&
    (hasWorktreeCardDetails({
      issue: hoverIssue,
      linearIssue: hoverLinearIssue,
      jiraIssue: hoverJiraIssue,
      review: hoverReview,
      comment: hoverComment,
      automationProvenance: metaAutomationProvenance,
      cliProvenance: metaCliProvenance
    }) ||
      workspacePorts.length > 0 ||
      hasHoverIdentity)
  // Why: the parent row owns metadata hover; don't stack the title's truncation tooltip on the details popover.
  const titleWrapper = newCardStyle
    ? hasHoverDetails
      ? (title: React.ReactElement): React.ReactElement => title
      : undefined
    : compactCards && (showBranchIdentityHover || hasDetails || hasPorts)
      ? (title: React.ReactElement): React.ReactElement => (
          <WorktreeCardDetailsHover
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            jiraIssue={metaJiraIssue}
            review={metaReview}
            comment={metaComment}
            automationProvenance={metaAutomationProvenance}
            cliProvenance={metaCliProvenance}
            automationHostId={worktree.hostId}
            branchName={showBranchIdentityHover ? branch : undefined}
            workspaceTitle={worktree.displayName}
            identityOrder="branch-first"
            detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
            openDelay={100}
            // Why: compact mode also renders the plug/badge hover root; sharing one open-state made hovering the
            // plug force-open the wider title card and race it closed (#9304), so let this title hover own its state.
            onEditIssue={affiliateListMode ? undefined : handleEditIssue}
            onEditComment={affiliateListMode ? undefined : handleEditComment}
            onOpenGitHubIssueInOrca={
              metaIssue && 'url' in metaIssue && metaIssue.url
                ? handleOpenGitHubIssueInOrca
                : undefined
            }
            onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
            onOpenReviewInOrca={
              metaReview?.url && metaReview.provider === 'github'
                ? handleOpenReviewInOrca
                : undefined
            }
            onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
            onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
            // Why: compact mode hides the metadata badge row, so title hover carries the explicit-link affordance.
            onUnlinkReview={
              !affiliateListMode && hasExplicitLinkedReview ? handleUnlinkReview : undefined
            }
          >
            {title}
          </WorktreeCardDetailsHover>
        )
      : undefined
  // Why: sidebar rows need a small surface inset while content stays aligned with the pre-inset layout.
  const applyNewCardStyleStatusLaneOffset = newCardStyle && showCombinedStatusSlot
  const cardPaddingLeft = flushSurface
    ? getFlushWorktreeCardPaddingLeft(contentIndent, applyNewCardStyleStatusLaneOffset)
    : contentIndent > 0
      ? `calc(0.125rem + ${contentIndent}px)`
      : null
  const parentContentMarginLeft =
    flushSurface && applyNewCardStyleStatusLaneOffset
      ? getNewCardStyleParentContentMarginLeft(contentIndent)
      : 0
  const cardStyle = cardPaddingLeft ? { paddingLeft: cardPaddingLeft } : undefined
  const detailsAndPortsContent =
    hasDetails || hasPorts ? (
      <div className="flex shrink-0 items-center gap-1">
        {hasPorts && <WorktreeCardPortsTrigger ports={workspacePorts} />}
        {hasDetails && (
          <WorktreeCardMetaBadges
            issue={metaIssue}
            linearIssue={metaLinearIssue}
            jiraIssue={metaJiraIssue}
            review={newCardStyle ? null : metaReview}
            comment={metaComment}
            automationProvenance={metaAutomationProvenance}
            cliProvenance={metaCliProvenance}
            className="ml-0 pr-0"
          />
        )}
      </div>
    ) : null
  const detailsAndPorts =
    detailsAndPortsContent && !newCardStyle ? (
      <WorktreeCardDetailsHover
        issue={metaIssue}
        linearIssue={metaLinearIssue}
        jiraIssue={metaJiraIssue}
        review={metaReview}
        comment={metaComment}
        automationProvenance={metaAutomationProvenance}
        cliProvenance={metaCliProvenance}
        automationHostId={worktree.hostId}
        detailsAfter={hasPorts ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null}
        hoverControl={detailsHoverControl}
        onEditIssue={affiliateListMode ? undefined : handleEditIssue}
        onEditComment={affiliateListMode ? undefined : handleEditComment}
        onOpenGitHubIssueInOrca={
          metaIssue && 'url' in metaIssue && metaIssue.url ? handleOpenGitHubIssueInOrca : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          metaReview?.url && metaReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
        onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
        // Why: branch lookup can surface a review without persisted metadata; only unlink when explicitly linked.
        onUnlinkReview={
          !affiliateListMode && hasExplicitLinkedReview ? handleUnlinkReview : undefined
        }
      >
        {detailsAndPortsContent}
      </WorktreeCardDetailsHover>
    ) : (
      detailsAndPortsContent
    )
  const titleRowIndicators = showTitleRowIndicators ? (
    <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">{detailsAndPorts}</div>
  ) : null
  const hasSecondaryCardContent =
    hasMetaRow || !!remoteBranchConflict || showInlineAgentList || showLineageChildChip
  const titleOnlyCard = !hasSecondaryCardContent

  const parentCardContent = (
    <div
      className={cn(
        'flex w-full min-w-0 gap-0.5 pl-0',
        titleOnlyCard ? 'items-center' : 'items-start'
      )}
      style={
        parentContentMarginLeft < 0 ? { marginLeft: `${parentContentMarginLeft}px` } : undefined
      }
      data-worktree-card-parent-content=""
    >
      {showCombinedStatusSlot ? (
        <div
          className={cn(
            'flex shrink-0 justify-center',
            newCardStyle ? 'mr-1 w-5 items-center' : 'items-start pt-[2px]',
            affiliateListMode && 'px-1'
          )}
          data-worktree-card-status-slot=""
        >
          <WorktreeCardStatusSlot
            worktreeId={worktree.id}
            showStatus={showStatus}
            showUnreadAction={showUnreadQuickAction}
            isUnread={worktree.isUnread}
            unreadTooltip={unreadTooltip}
            onPointerDown={stopQuickActionPointerPropagation}
            onToggleUnread={handleToggleUnreadQuick}
            prDisplay={statusLaneReview}
            newCardStyle={newCardStyle}
            hasBranchIdentity={Boolean(branchIdentityDisplay)}
          />
        </div>
      ) : null}

      {/* Content area */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          // Why: inline agent rows intentionally outdent into the card gutter; inner elements handle truncation.
          showInlineAgentList || (!newCardStyle && lineageChildren)
            ? 'overflow-visible'
            : 'overflow-hidden'
        )}
      >
        {/* Header row: Title */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {showOriginRepoIcon && (
              <RepoIdentityChip repo={repo}>
                <RepoIconGlyph
                  repoIcon={repo.repoIcon}
                  color={resolveRepoHeaderColor(repo.badgeColor)}
                  className="size-full"
                  iconClassName="size-3"
                />
              </RepoIdentityChip>
            )}

            {repo?.connectionId && (
              <WorktreeCardSshHostControl
                targetId={repo.connectionId}
                targetLabel={sshTargetLabel || repo.displayName}
                status={sshStatus}
                targetRemoved={sshTargetRemoved}
                sshOwnerEnvironmentId={sshOwnerEnvironmentId}
                iconOnly={compactCards || newCardStyle}
                onPointerDown={stopQuickActionPointerPropagation}
              />
            )}

            {!repo?.connectionId && parsedRepoHost?.kind === 'runtime' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0 inline-flex items-center">
                    {isRuntimeDisconnected ? (
                      // Passive by design: runtime ("Orca server") hosts have no
                      // renderer-reachable connect API, unlike the SSH glyph above which is
                      // now a control. Don't "fix" the inconsistency by wiring one up.
                      <ServerOff className="size-3 text-destructive" />
                    ) : (
                      <Server className="size-3 text-muted-foreground" />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {isRuntimeDisconnected
                    ? runtimeHostLabel
                      ? translate(
                          'auto.components.sidebar.WorktreeCard.runtimeHostDisconnectedNamed',
                          '{{hostName}} disconnected',
                          { hostName: runtimeHostLabel }
                        )
                      : translate(
                          'auto.components.sidebar.WorktreeCard.runtimeHostDisconnected',
                          'Server disconnected'
                        )
                    : runtimeHostLabel
                      ? translate(
                          'auto.components.sidebar.WorktreeCard.runtimeHostProjectNamed',
                          'Project on {{hostName}}',
                          { hostName: runtimeHostLabel }
                        )
                      : translate(
                          'auto.components.sidebar.WorktreeCard.runtimeHostProject',
                          'Project on Orca server'
                        )}
                </TooltipContent>
              </Tooltip>
            )}

            {showInlineRepoBadge && (
              <RepoIdentityChip repo={repo}>
                <RepoIconGlyph
                  repoIcon={repo.repoIcon}
                  color={resolveRepoHeaderColor(repo.badgeColor)}
                  className="size-full"
                  iconClassName="size-3"
                />
              </RepoIdentityChip>
            )}

            {/* Why: unread alert lives in the left status lane; title-row contrast comes from weight and dimmed read titles. */}
            <WorktreeTitleInlineRename
              displayName={visibleCardTitle}
              disabled={isDeleting || affiliateListMode}
              showUnreadEmphasis={showUnreadEmphasis}
              dimReadTitle={newCardStyle}
              className="text-[13px] leading-5"
              editingClassName="flex-1"
              titleWrapper={titleWrapper}
              onEditingChange={affiliateListMode ? undefined : setTitleRenaming}
              onRename={handleRenameTitle}
              beginEditing={
                !affiliateListMode &&
                shouldBeginWorktreeRename(renamingWorktreeId, worktree.id, renameRowKey)
              }
              onBeginEditingConsumed={
                affiliateListMode ? undefined : () => setRenamingWorktreeId(null)
              }
            />

            {typeof worktree.firstAgentMessageRenameError === 'string' &&
            worktree.firstAgentMessageRenameError.length > 0 &&
            !titleRenaming ? (
              // Why: the error can be raw agent CLI output, so the badge opens a dialog rather than a tooltip.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    onPointerDown={stopQuickActionPointerPropagation}
                    onClick={handleOpenRenameErrorDialog}
                    onDoubleClick={handleOpenRenameErrorDialog}
                    className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
                    aria-label={translate(
                      'auto.components.sidebar.WorktreeCard.02e19349f4',
                      'Auto-rename failed: view error'
                    )}
                  >
                    <AlertCircle className="size-2.5" />
                    {translate('auto.components.sidebar.WorktreeCard.74522ee457', 'rename failed')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {translate(
                    'auto.components.sidebar.WorktreeCard.4eba2ea99e',
                    'Auto-name failed. Click to see details.'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {!compactCards && worktree.isMainWorktree && !isFolder && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-foreground/70 border-foreground/20 bg-foreground/[0.06]"
                  >
                    {translate('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {translate(
                    'auto.components.sidebar.WorktreeCard.0777de5970',
                    'Primary worktree (original clone directory)'
                  )}
                </TooltipContent>
              </Tooltip>
            )}

            {worktree.isSparse && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5"
                  >
                    {translate('auto.components.sidebar.WorktreeCard.4f964d5e8c', 'sparse')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-72">
                  <div className="space-y-1">
                    <div>
                      {translate(
                        'auto.components.sidebar.WorktreeCard.0f33af979b',
                        'Partial checkout. Files outside these paths are not on disk.'
                      )}
                    </div>
                    {worktree.sparseDirectories && worktree.sparseDirectories.length > 0 ? (
                      <div className="font-mono text-[11px] opacity-80">
                        {formatSparseDirectoryPreview(worktree.sparseDirectories)}
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}

            {showTitleRowIndicators && titleRowIndicators}
          </div>

          {showHeaderActions && (
            <div className="ml-auto flex shrink-0 items-center justify-center gap-1 pr-1.5">
              {showTitleRowPrimary && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="shrink-0 inline-flex items-center"
                      aria-label={translate(
                        'auto.components.sidebar.WorktreeCard.0d224eff10',
                        'Primary worktree'
                      )}
                    >
                      <Star className="size-3 fill-amber-400 text-amber-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {translate(
                      'auto.components.sidebar.WorktreeCard.0777de5970',
                      'Primary worktree (original clone directory)'
                    )}
                  </TooltipContent>
                </Tooltip>
              )}

              {showDeleteQuickAction && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-workspace-board-preserve-open=""
                      onPointerDown={stopQuickActionPointerPropagation}
                      onClick={handleWorkspaceQuickAction}
                      className={cn(
                        'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity',
                        'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
                        'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
                      )}
                      aria-label={translate(
                        'auto.components.sidebar.WorktreeCard.6f09f58541',
                        'Delete workspace'
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {translate(
                      'auto.components.sidebar.WorktreeCard.6f09f58541',
                      'Delete workspace'
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {hasMetaRow && (
          <div className="flex items-center gap-1.5 min-w-0" data-worktree-card-meta-row="">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {showRepoBadgeInMetaRow && repo && (
                <div className="flex items-center gap-1.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60">
                  <RepoBadgeMark color={repo.badgeColor} />
                  <span className="text-[10px] font-semibold text-foreground truncate max-w-[6rem] leading-none lowercase">
                    {repo.displayName}
                  </span>
                </div>
              )}

              {showHostContextBadge && (
                <Badge
                  variant="secondary"
                  className="h-[16px] max-w-[7rem] shrink-0 rounded border border-border bg-accent px-1.5 text-[10px] font-medium leading-none text-muted-foreground dark:bg-accent/80 dark:border-border/50"
                >
                  <span className="truncate">{hostContextLabel}</span>
                </Badge>
              )}

              {showIdentityInNewCard ? (
                <TruncatedSidebarLabel
                  text={identityDisplay!}
                  className="text-[11px] text-muted-foreground leading-none"
                  tooltipEnabled={!hasHoverDetails}
                />
              ) : isFolder && !newCardStyle ? (
                <span
                  className="min-w-0 truncate font-mono text-[11px] leading-none text-muted-foreground"
                  title={worktree.path}
                >
                  {getDirectoryName(worktree.path)}
                </span>
              ) : showBranch ? (
                <TruncatedSidebarLabel
                  text={branch}
                  className="text-[11px] text-muted-foreground leading-none"
                  // Why: whole-card details hover already shows full identity; a nested tooltip would compete for it.
                  tooltipEnabled={!hasHoverDetails}
                />
              ) : showDetachedHeadInMetaRow && detachedHeadDisplay ? (
                <DetachedHeadBadge
                  display={detachedHeadDisplay}
                  label="sidebar"
                  side="right"
                  className="h-[16px]"
                />
              ) : null}

              {showConflictOperationBadge && (
                <Badge
                  variant="outline"
                  className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 gap-1 text-amber-600 border-amber-500/30 bg-amber-500/5 dark:text-amber-400 dark:border-amber-400/30 dark:bg-amber-400/5 leading-none"
                >
                  <GitMerge className="size-2.5" />
                  {CONFLICT_OPERATION_LABELS[conflictOperation]}
                </Badge>
              )}

              {cacheStartedAt != null && (
                <CacheTimer startedAt={cacheStartedAt} ttlMs={cacheTtlMs} />
              )}
            </div>

            {showMetaRowDetails && (
              <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">
                {detailsAndPorts}
              </div>
            )}
          </div>
        )}

        {remoteBranchConflict && (
          <div className="mt-0.5 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-[1px] size-3 shrink-0" />
            <span className="min-w-0 flex-1">
              {translate(
                'auto.components.sidebar.WorktreeCard.a88c92d0e3',
                '{{value0}}/{{value1}} already exists.',
                {
                  value0: remoteBranchConflict.remote,
                  value1: remoteBranchConflict.branchName
                }
              )}
            </span>
          </div>
        )}

        {isActive && worktree.linkedLinearIssue ? (
          <LinearAgentSkillSetupPrompt
            linked
            remote={Boolean(repo?.connectionId || settings?.activeRuntimeEnvironmentId?.trim())}
            surface="modal"
            settings={settings}
          />
        ) : null}

        {/* Why: counterbalance the card stack gap (-mt-1) so agents right after the title read as one header group. */}
        {showInlineAgentList && (
          <WorktreeCardAgents
            worktreeId={worktree.id}
            agents={agentActivityDisplayMode === 'compact' ? compactInlineAgentRows : undefined}
            className={hasMetaRow || remoteBranchConflict ? 'mt-0' : '-mt-1'}
          />
        )}

        {showLineageChildChip && (
          <div
            className={cn('relative mt-1 flex min-w-0 justify-start', !newCardStyle && '-ml-1')}
            style={{
              color: 'color-mix(in srgb, var(--muted-foreground) 42%, var(--worktree-sidebar))'
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="relative z-10 h-[18px] max-w-[8rem] gap-1 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
                  aria-label={lineageChildAriaLabel}
                  aria-expanded={!lineageCollapsed}
                  onClick={onLineageToggle}
                >
                  <Workflow className="size-2.5" />
                  <span className="truncate">{childWorkspaceShortLabel}</span>
                  <ChevronDown
                    className={cn(
                      'size-2.5 transition-transform',
                      lineageCollapsed && '-rotate-90'
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {lineageCollapsed
                  ? translate(
                      'auto.components.sidebar.WorktreeCard.8cb634cda6',
                      'Show child workspaces'
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeCard.57eaa61b55',
                      'Hide child workspaces'
                    )}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {!newCardStyle && lineageChildren && (
          <div className="-ml-[1.125rem] mt-1.5 w-[calc(100%+1.125rem)] space-y-1">
            {lineageChildren}
          </div>
        )}
      </div>
    </div>
  )

  const parentHoverTriggerBody = (
    <div className="group/worktree-card w-full min-w-0" data-worktree-card-hover-trigger="">
      {parentCardContent}
    </div>
  )

  const parentCardBodyWithHoverDetails =
    hasHoverDetails && !titleRenaming ? (
      <WorktreeCardDetailsHover
        issue={hoverIssue}
        linearIssue={hoverLinearIssue}
        jiraIssue={hoverJiraIssue}
        review={hoverReview}
        comment={hoverComment}
        automationProvenance={metaAutomationProvenance}
        cliProvenance={metaCliProvenance}
        automationHostId={worktree.hostId}
        branchName={hoverBranchName}
        workspaceTitle={hoverWorkspaceTitle}
        workspaceTitleRenameDisabled={isDeleting || affiliateListMode}
        detailsAfter={
          workspacePorts.length > 0 ? <WorktreeCardPortsDetails ports={workspacePorts} /> : null
        }
        openDelay={100}
        hoverControl={detailsHoverControl}
        onRenameWorkspaceTitle={affiliateListMode ? undefined : handleRenameTitle}
        onEditIssue={affiliateListMode ? undefined : handleEditIssue}
        onEditComment={affiliateListMode ? undefined : handleEditComment}
        onOpenGitHubIssueInOrca={
          hoverIssue && 'url' in hoverIssue && hoverIssue.url
            ? handleOpenGitHubIssueInOrca
            : undefined
        }
        onOpenLinearIssueInOrca={linearIssue?.url ? handleOpenLinearIssueInOrca : undefined}
        onOpenReviewInOrca={
          hoverReview?.url && hoverReview.provider === 'github' ? handleOpenReviewInOrca : undefined
        }
        onOpenAutomation={affiliateListMode ? undefined : handleOpenAutomation}
        onOpenAutomationRun={affiliateListMode ? undefined : handleOpenAutomationRun}
        // Why: branch lookup can surface a review without persisted metadata; only unlink when explicitly linked.
        onUnlinkReview={
          !affiliateListMode && hasExplicitLinkedReview ? handleUnlinkReview : undefined
        }
      >
        {parentHoverTriggerBody}
      </WorktreeCardDetailsHover>
    ) : (
      parentHoverTriggerBody
    )

  const cardBody = (
    <div
      className={cn(
        'relative flex cursor-pointer flex-col pr-1.5 transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none',
        titleOnlyCard ? 'py-0.5' : 'pt-0.5 pb-1',
        flushSurface ? 'ml-1 w-[calc(100%-0.25rem)]' : 'ml-1',
        'rounded-lg',
        // Why: the live data attribute updates before React state during navigation,
        // so it must own the complete active style without stale utility classes.
        isLineageDropTarget
          ? 'border border-accent-foreground/20 bg-accent/80'
          : isActiveSurface
            ? 'border border-transparent'
            : isMultiSelected
              ? 'border border-worktree-sidebar-ring/35 bg-worktree-sidebar-accent/70 ring-1 ring-worktree-sidebar-ring/30'
              : 'border border-transparent worktree-sidebar-card-hover',
        isActiveSurface && isMultiSelected && 'ring-1 ring-worktree-sidebar-ring/35',
        revealHighlight && [
          'scroll-to-current-workspace-reveal-highlight',
          revealHighlightTone === 'ai' && 'scroll-to-current-workspace-reveal-highlight--ai'
        ],
        titleRenaming && '!border-transparent !bg-transparent !shadow-none !ring-0',
        isDeleting && 'opacity-50 grayscale cursor-not-allowed',
        // Why: no SSH dim — the inline host control now states the disconnected state
        // explicitly, and a subtree opacity would composite its destructive tint and spinner
        // down to an illegible alpha (a descendant cannot escape an ancestor's opacity).
        isRuntimeDisconnected && !isDeleting && 'opacity-60'
      )}
      data-worktree-card-surface="true"
      data-worktree-card-active={isActiveSurface ? activeSurfaceVariant : undefined}
      onClick={handleClick}
      onDoubleClick={affiliateListMode ? undefined : handleDoubleClick}
      draggable={!affiliateListMode && nativeDragEnabled && !isDeleting && !titleRenaming}
      onDragStart={!affiliateListMode && nativeDragEnabled ? handleDragStart : undefined}
      onDragEnd={!affiliateListMode && nativeDragEnabled ? handleDragEnd : undefined}
      aria-busy={isDeleting}
      style={cardStyle}
    >
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            {!isQueuedForDeletion ? (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
            {deleteLabel}
          </div>
        </div>
      )}
      {parentCardBodyWithHoverDetails}

      {newCardStyle && lineageChildren ? (
        <div
          className="mt-1.5 space-y-1"
          data-worktree-lineage-children=""
          style={lineageChildrenStyle}
        >
          {lineageChildren}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      {affiliateListMode ? (
        cardBody
      ) : (
        <WorktreeContextMenu
          worktree={worktree}
          selectedWorktrees={selectedWorktrees}
          onContextMenuSelect={handleContextMenuSelect}
          onAssignWorkspaceStatus={onAssignWorkspaceStatus}
        >
          {cardBody}
        </WorktreeContextMenu>
      )}

      {typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0 && (
          <AutoRenameFailedDialog
            open={showRenameErrorDialog}
            onOpenChange={setShowRenameErrorDialog}
            worktreeId={worktree.id}
            worktreeName={worktree.displayName}
            error={worktree.firstAgentMessageRenameError}
          />
        )}
    </>
  )
})

export default WorktreeCard
