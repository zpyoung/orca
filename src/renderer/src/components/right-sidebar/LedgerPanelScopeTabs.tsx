import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import type { LedgerPanelTier } from './ledger-panel-scope'

export function ledgerPanelTierLabel(tier: LedgerPanelTier, isFolderWorkspace: boolean): string {
  switch (tier) {
    case 'workspace':
      return isFolderWorkspace
        ? translate('ledger.panel.scope.folder', 'Folder')
        : translate('ledger.panel.scope.worktree', 'Worktree')
    case 'project':
      return translate('ledger.panel.project', 'Project')
    case 'group':
      return translate('ledger.panel.group', 'Group')
  }
}

// Why: the outline variant sets dark:bg-input/30, which tailwind-merge keeps alongside an
// unprefixed bg-*, so every selected-state color needs an explicit dark counterpart to win.
export const TIER_ACTIVE_CLASS =
  'bg-primary/15 font-semibold text-foreground hover:bg-primary/20 dark:bg-primary/25 dark:hover:bg-primary/30'

export function LedgerPanelScopeTabs({
  tiers,
  value,
  isFolderWorkspace,
  disabled,
  onChange
}: {
  tiers: LedgerPanelTier[]
  value: LedgerPanelTier
  isFolderWorkspace: boolean
  disabled: boolean
  onChange: (tier: LedgerPanelTier) => void
}): React.JSX.Element {
  return (
    <ButtonGroup
      aria-label={translate('ledger.panel.scopeLabel', 'Ledger scope')}
      className="w-full"
    >
      {tiers.map((tier) => (
        <Button
          key={tier}
          aria-pressed={tier === value}
          variant="outline"
          size="xs"
          className={tier === value ? `flex-1 ${TIER_ACTIVE_CLASS}` : 'flex-1'}
          disabled={disabled}
          onClick={() => onChange(tier)}
        >
          {ledgerPanelTierLabel(tier, isFolderWorkspace)}
        </Button>
      ))}
    </ButtonGroup>
  )
}
