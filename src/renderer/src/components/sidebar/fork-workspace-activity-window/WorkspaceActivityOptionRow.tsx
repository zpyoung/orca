import type React from 'react'
import { useAppStore } from '@/store'
import { WorkspaceFilterOptionRow } from '../workspace-filter-option-row'
import { WorkspaceActivityWindowControl } from './WorkspaceActivityWindowControl'

/** Stands in for the shared hide-sleeping row; a store without the activity slice keeps that row. */
export function WorkspaceActivityOptionRow(): React.JSX.Element {
  const activityWindow = useAppStore((state) => state.workspaceActivityWindow)
  return activityWindow === undefined ? (
    <WorkspaceFilterOptionRow optionKey="hideSleepingWorkspaces" />
  ) : (
    <WorkspaceActivityWindowControl />
  )
}
