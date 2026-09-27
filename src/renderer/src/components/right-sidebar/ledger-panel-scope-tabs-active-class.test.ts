import { describe, expect, it } from 'vitest'
import { twMerge } from 'tailwind-merge'
import { TIER_ACTIVE_CLASS } from './LedgerPanelScopeTabs'

// The Button outline variant, verbatim from src/renderer/src/components/ui/button.tsx.
const OUTLINE_VARIANT =
  'border border-border bg-background text-foreground shadow-xs hover:border-muted-foreground/35 hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50'

function merged(): string[] {
  return twMerge(OUTLINE_VARIANT, TIER_ACTIVE_CLASS).split(' ')
}

describe('ledger panel scope tab active styling', () => {
  it.each([
    ['light', 'bg-'],
    ['dark', 'dark:bg-']
  ])('survives the outline variant in %s mode', (_mode, prefix) => {
    const backgrounds = merged().filter(
      (name) => name.startsWith(prefix) && !name.includes('hover:')
    )
    expect(backgrounds).toEqual([`${prefix}primary/${prefix === 'bg-' ? '15' : '25'}`])
  })
  it('overrides the variant hover background in both modes', () => {
    const hovers = merged().filter((name) => name.includes('hover:bg-'))
    expect(hovers).toEqual(['hover:bg-primary/20', 'dark:hover:bg-primary/30'])
  })
})
