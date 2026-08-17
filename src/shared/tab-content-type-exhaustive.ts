import type { TabContentType } from './types'

/** The four content types whose entityId is a file path routed through the editor surface. */
export const EDITOR_FAMILY_TAB_CONTENT_TYPES: readonly TabContentType[] = [
  'editor',
  'diff',
  'conflict-review',
  'check-details'
]

/** Forces a compile error at any `switch (tab.contentType)` default arm left unhandled. */
export function assertExhaustiveTabContentType(value: never): never {
  throw new Error(`Unhandled TabContentType: ${String(value)}`)
}
