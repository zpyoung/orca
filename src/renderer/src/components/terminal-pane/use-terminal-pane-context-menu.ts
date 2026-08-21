import { useCallback, useRef } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'
import type { TerminalPasteSource } from './terminal-paste-coordinator'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import { useAppStore } from '@/store'
import { resolveProtectedMultilinePasteOptionsForPane } from './terminal-agent-paste-bracketing'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'
import { translate } from '@/i18n/i18n'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { copyTerminalHandleForPane } from './terminal-handle-copy'
import { runCopyPaneId, runTerminalCopy } from './terminal-copy-rejection-guards'
import { copyTerminalSelection } from './terminal-selection-copy'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

export function recordContextMenuCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: 'contextual_tour' | 'context_menu'
    direction: 'vertical' | 'horizontal'
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  containerRef: React.RefObject<HTMLDivElement | null>
  tabId: string
  worktreeId: string
  groupId: string | null
  fallbackCwd: string
  toggleExpandPane: (paneId: number) => void
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onClearPaneTitle: (paneId: number) => void
  onPasteError: (message: string) => void
  onAgentSessionForkReady: (fork: PreparedAgentSessionFork) => void
  onAgentSessionContinuationReady: (request: AgentSessionContinuationRequest) => void
  forceBracketedMultilineTextPaste: boolean
  rightClickToPaste: boolean
}

type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
  onCopy: () => Promise<void>
  onSelectAll: () => void
  onCopyTerminalId: () => Promise<void>
  onCopyPaneId: () => Promise<void>
  onPaste: () => Promise<void>
  onSplitRight: () => void
  onSplitDown: () => void
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onForkAgentSession: () => Promise<void>
  onContinueAgentSessionInNewSession: () => void
  onCopyAgentSessionContext: () => Promise<void>
  onQuickCommand: (command: TerminalQuickCommand, historyId: string) => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onClearPaneTitle: () => void
  runForPane: <Result>(paneId: number, action: () => Result) => Result
}

export function useTerminalPaneContextMenu({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  containerRef,
  tabId,
  worktreeId,
  groupId,
  fallbackCwd,
  toggleExpandPane,
  onRequestClosePane,
  onClearPaneScrollback,
  onSetTitle,
  onClearPaneTitle,
  onPasteError,
  onAgentSessionForkReady,
  onAgentSessionContinuationReady,
  forceBracketedMultilineTextPaste,
  rightClickToPaste
}: UseTerminalPaneContextMenuDeps): TerminalMenuState {
  const contextPaneIdRef = useRef<number | null>(null)

  const resolveMenuPane = useCallback((): ManagedPane | null => {
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    const panes = manager.getPanes()
    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((pane) => pane.id === contextPaneIdRef.current) ?? null
      return clickedPane
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }, [managerRef])

  const pasteResolvedPane = async (
    source: Extract<TerminalPasteSource, 'context-menu' | 'right-click'>
  ): Promise<void> =>
    pasteTerminalPaneMenuClipboard(
      {
        managerRef,
        paneTransportsRef,
        tabId,
        worktreeId,
        forceBracketedMultilineTextPaste,
        onPasteError
      },
      resolveMenuPane(),
      source
    )

  const { open, setOpen, point, menuOpenedAtRef, onContextMenuCapture, onPaneTitleContextMenu } =
    useTerminalContextMenuTrigger({
      managerRef,
      containerRef,
      contextPaneIdRef,
      rightClickToPaste,
      pasteResolvedPane
    })

  const { onSplitRight, onSplitDown } = useTerminalPaneSplitActions({
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    contextPaneIdRef,
    tabId,
    fallbackCwd,
    resolveMenuPane
  })

  const agentSessionContext = {
    paneCwdRef,
    tabId,
    worktreeId,
    groupId,
    fallbackCwd,
    onAgentSessionForkReady,
    onAgentSessionContinuationReady
  }

  const onCopy = async (): Promise<void> => copyTerminalPaneMenuSelection(resolveMenuPane())

  const onSelectAll = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      pane.terminal.selectAll()
      pane.terminal.focus()
    }
  }

  const onCopyPaneId = async (): Promise<void> =>
    copyTerminalPaneMenuPaneId(resolveMenuPane(), tabId)

  const getShortcutPlatform = (): NodeJS.Platform => {
    if (navigator.userAgent.includes('Mac')) {
      return 'darwin'
    }
    return navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
  }

  const isPanePasteTargetMounted = (
    pane: ManagedPane,
    transport: PtyTransport | undefined,
    ptyId: string | null
  ): boolean => {
    return isTerminalPanePasteTargetCurrent({
      manager: managerRef.current,
      paneTransports: paneTransportsRef.current,
      paneId: pane.id,
      leafId: pane.leafId,
      transport,
      ptyId
    })
  }

  const executeMenuPasteText = async (
    pane: ManagedPane,
    source: TerminalPasteSource,
    text: string,
    options?: TerminalPasteTextOptions
  ): Promise<boolean> => {
    const connectionId = getConnectionId(worktreeId) ?? null
    const transport = paneTransportsRef.current.get(pane.id)
    const ptyId = transport?.getPtyId() ?? null
    const shortcutPlatform = getShortcutPlatform()
    const plan = await planTerminalPasteWithYield({
      text,
      source,
      target: {
        kind: 'terminal',
        paneId: pane.id,
        leafId: pane.leafId,
        ptyId,
        runtime: resolveTerminalPasteRuntime({
          platform: shortcutPlatform,
          ptyId,
          connectionId,
          remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
          transport,
          isWindowsConpty: forceBracketedMultilineTextPaste
        })
      },
      forceBracketedPaste: options?.forceBracketedPaste,
      forceBracketedPasteForMultiline: options?.forceBracketedPasteForMultiline,
      windowsInputRecordNewline: options?.windowsInputRecordNewline,
      terminalBracketedPasteMode: pane.terminal.modes.bracketedPasteMode
    })
    const execution = await executeTerminalPastePlan(plan, {
      pasteText: (pasteText, pasteOptions) =>
        pasteTerminalText(pane.terminal, pasteText, pasteOptions),
      writePty: (data) => writeTerminalPastePtyInput(transport, data),
      isTargetCurrent: () => isPanePasteTargetMounted(pane, transport, ptyId),
      canContinue: () => isPanePasteTargetMounted(pane, transport, ptyId)
    })
    if (execution.status !== 'pasted') {
      onPasteError(formatTerminalPasteExecutionError(execution.reason))
      return false
    }
    if (text) {
      recordTerminalUserInputForLeaf(tabId, pane.leafId)
    }
    if (options?.recoverImagePasteWebglAtlas) {
      scheduleImagePasteWebglAtlasRecovery()
    }
    return true
  }

  const onCopyTerminalId = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    try {
      await copyTerminalHandleForPane({
        tabId,
        leafId: pane.leafId,
        callRuntime: window.api.runtime.call,
        writeClipboardText: window.api.ui.writeTerminalClipboardText
      })
      toast.success(
        translate(
          'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copied',
          'Terminal ID copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copy.failed',
          'Unable to copy terminal ID'
        )
      )
    } finally {
      pane.terminal.focus()
    }
  }

  const pasteResolvedPane = async (
    source: Extract<TerminalPasteSource, 'context-menu' | 'right-click'>
  ): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const connectionId = getConnectionId(worktreeId) ?? null
    const state = useAppStore.getState()
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    const transport = paneTransportsRef.current.get(pane.id) ?? null
    const result = await pasteTerminalClipboard({
      readClipboardText: window.api.ui.readClipboardText,
      saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
      connectionId,
      runtimeEnvironmentId,
      protectedMultilineTextPasteOptions: resolveProtectedMultilinePasteOptionsForPane({
        isWindowsClient: forceBracketedMultilineTextPaste,
        hostPlatform: resolveTerminalInputHostPlatform({
          clientPlatform: getShortcutPlatform(),
          state,
          worktreeId,
          transport
        }),
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
        tabId,
        leafId: pane.leafId
      }),
      pasteText: (text, options) => executeMenuPasteText(pane, source, text, options),
      onTextPasteError: () =>
        onPasteError('Paste failed: clipboard text is too large for a safe terminal paste.'),
      onImagePasteError: (error) => {
        const detail = error instanceof Error ? error.message : String(error)
        onPasteError(`Image paste failed: ${detail}`)
      }
    })
    if (result.status !== 'pasted') {
      return
    }
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close. Refocus only after a completed paste so rejected async targets
    // do not steal focus from the user's new control.
    pane.terminal.focus()
  }

  const onPaste = async (): Promise<void> => pasteResolvedPane('context-menu')

  const onEqualizePaneSizes = (): void => {
    const pane = resolveMenuPane()
    const manager = managerRef.current
    if (!pane || !manager) {
      return
    }
    manager.equalizePaneSizes()
    pane.terminal.focus()
  }

  const onClosePane = (): void => {
    const pane = resolveMenuPane()
    if (pane && (managerRef.current?.getPanes().length ?? 0) > 1) {
      onRequestClosePane(pane.id)
    }
  }

  const onClearScreen = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onClearPaneScrollback(pane)
    }
  }

  const onForkAgentSession = async (): Promise<void> =>
    forkAgentSessionFromMenuPane(agentSessionContext, resolveMenuPane())

  const onContinueAgentSessionInNewSession = (): void =>
    continueAgentSessionFromMenuPane(agentSessionContext, resolveMenuPane())

  const onCopyAgentSessionContext = async (): Promise<void> =>
    copyAgentSessionContextFromMenuPane(resolveMenuPane())

  const onQuickCommand = (command: TerminalQuickCommand, historyId: string): void => {
    if (isTerminalAgentQuickCommand(command)) {
      runQuickCommandInNewTab({ command, worktreeId, groupId, historyId })
      return
    }

    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    sendTerminalQuickCommandToPane({
      command,
      pane,
      tabId,
      transport: paneTransportsRef.current.get(pane.id)
    })
  }

  const onToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      toggleExpandPane(pane.id)
    }
  }

  /** Routes title edits through the resolved menu pane instead of active pane. */
  const handleSetTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onSetTitle(pane.id)
    }
  }

  /** Clears the title for the pane that opened the context menu. */
  const handleClearPaneTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onClearPaneTitle(pane.id)
    }
  }

  const runForPane = <Result>(paneId: number, action: () => Result): Result => {
    const previousPaneId = contextPaneIdRef.current
    contextPaneIdRef.current = paneId
    try {
      return action()
    } finally {
      contextPaneIdRef.current = previousPaneId
    }
  }

  // Why: PaneManager.getPanes() allocates public pane wrappers. Closed menus
  // do not need pane counts or target identity, so avoid that work on every
  // render across hundreds of mounted terminal tabs.
  const paneCount = open ? (managerRef.current?.getPanes().length ?? 1) : 1
  const menuPaneId = open ? (resolveMenuPane()?.id ?? null) : null

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    onContextMenuCapture,
    onPaneTitleContextMenu,
    onCopy,
    onSelectAll,
    onCopyTerminalId,
    onCopyPaneId,
    onPaste,
    onSplitRight,
    onSplitDown,
    onEqualizePaneSizes,
    onClosePane,
    onClearScreen,
    onForkAgentSession,
    onContinueAgentSessionInNewSession,
    onCopyAgentSessionContext,
    onQuickCommand,
    onToggleExpand,
    onSetTitle: handleSetTitle,
    onClearPaneTitle: handleClearPaneTitle,
    runForPane
  }
}
