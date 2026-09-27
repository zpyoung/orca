import { translate } from '@/i18n/i18n'

import type { LedgerOwner } from '../../../../shared/ledger'

/**
 * Tier wording shared by every ledger surface.
 *
 * The detached forms are separate entries rather than `tierLabel().toLowerCase()`
 * because case and word order of "detached project ledger" do not survive a
 * mechanical lowercase in most target languages.
 */

export function tierLabel(tier: LedgerOwner['tier']): string {
  return tier === 'project'
    ? translate('ledger.panel.project', 'Project')
    : translate('ledger.panel.group', 'Group')
}

export function detachedTierLabel(tier: LedgerOwner['tier']): string {
  return tier === 'project'
    ? translate('ledger.tier.detachedProject', 'Detached project ledger')
    : translate('ledger.tier.detachedGroup', 'Detached group ledger')
}
