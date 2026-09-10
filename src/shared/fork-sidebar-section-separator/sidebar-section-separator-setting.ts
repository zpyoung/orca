export function isSidebarSectionSeparatorEnabled(
  settings: { sidebarSectionSeparators?: boolean } | null | undefined
): boolean {
  return settings?.sidebarSectionSeparators !== false
}
