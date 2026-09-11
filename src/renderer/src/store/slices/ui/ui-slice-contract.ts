import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { UISliceCore } from './ui-slice-contract-core'
import type { UISliceContextual } from './ui-slice-contract-contextual'
import type {
  UISlicePersistence,
  UISlicePreferences,
  UISliceSurfaces
} from './ui-slice-contract-preferences'
import type { UISliceLedgerPage } from './ui-slice-contract-ledger-page'

export type {
  AgentSendPopoverTargetMode,
  NewWorkspaceDraft,
  OpenAgentSendPopoverTargetModeArgs,
  PendingSidebarRowReveal,
  PendingSidebarWorktreeReveal,
  TaskPageData,
  UISliceCore,
  UiViewHistory
} from './ui-slice-contract-core'
export type { UISliceContextual } from './ui-slice-contract-contextual'
export type {
  UISlicePersistence,
  UISlicePreferences,
  UISliceSurfaces
} from './ui-slice-contract-preferences'

export type UISlice = UISliceCore &
  UISliceContextual &
  UISlicePreferences &
  UISliceSurfaces &
  UISlicePersistence &
  UISliceLedgerPage

type UISliceStateCreator = StateCreator<AppState, [], [], UISlice>
export type UISliceSet = Parameters<UISliceStateCreator>[0]
export type UISliceGet = Parameters<UISliceStateCreator>[1]
