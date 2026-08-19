import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/types'

const updateSettings = vi.fn()
const storeState: { settings: Partial<GlobalSettings> | null } = { settings: {} }

vi.mock('../../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ ...storeState, updateSettings })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const { NativeChatWidthMenu } = await import('./NativeChatWidthMenu')

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

/** The radio group is the single element carrying both a tier value and a
 *  change handler, so match on that rather than on tree position. */
function findRadioGroup(node: unknown): ReactElementLike {
  const tiers = new Set(['narrow', 'comfortable', 'wide', 'full'])
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      typeof entry.props.value === 'string' &&
      tiers.has(entry.props.value) &&
      typeof entry.props.onValueChange === 'function'
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('width radio group not found')
  }
  return found
}

function tierOptions(node: unknown): string[] {
  const values: string[] = []
  visit(findRadioGroup(node).props.children, (entry) => {
    if (typeof entry.props.value === 'string') {
      values.push(entry.props.value)
    }
  })
  return values
}

beforeEach(() => {
  updateSettings.mockReset()
  storeState.settings = {}
})

describe('NativeChatWidthMenu', () => {
  it('lists every tier in the shared order', () => {
    expect(tierOptions(NativeChatWidthMenu())).toEqual(['narrow', 'comfortable', 'wide', 'full'])
  })

  it('checks the tier the setting currently holds', () => {
    storeState.settings = { nativeChatWidth: 'wide' }

    expect(findRadioGroup(NativeChatWidthMenu()).props.value).toBe('wide')
  })

  it('checks comfortable while settings are still loading', () => {
    storeState.settings = null

    expect(findRadioGroup(NativeChatWidthMenu()).props.value).toBe('comfortable')
  })

  it('writes the chosen tier to the global setting', () => {
    const onValueChange = findRadioGroup(NativeChatWidthMenu()).props.onValueChange as (
      value: string
    ) => void

    onValueChange('full')

    expect(updateSettings).toHaveBeenCalledWith({ nativeChatWidth: 'full' })
  })
})
