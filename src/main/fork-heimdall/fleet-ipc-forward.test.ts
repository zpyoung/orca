import { describe, expect, it, vi } from 'vitest'
import type { HeimdallFleetSnapshotReader } from '../../shared/fork-heimdall/remote-reader-schemas'
import { forwardHeimdallFleetToRenderer } from './fleet-ipc-forward'

vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: vi.fn(() => null)
}))

function fakeWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() }
  }
}

describe('forwardHeimdallFleetToRenderer', () => {
  it('forwards each full snapshot to both live renderer surfaces', () => {
    let listener: ((snapshot: HeimdallFleetSnapshotReader) => void) | null = null
    const unsubscribe = vi.fn()
    const transport = {
      subscribe: (next: (snapshot: HeimdallFleetSnapshotReader) => void) => {
        listener = next
        return unsubscribe
      }
    }
    const main = fakeWindow()
    const dashboard = fakeWindow()
    const stop = forwardHeimdallFleetToRenderer(
      transport,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeWindow() only needs isDestroyed/webContents.send, which is all forwardHeimdallFleetToRenderer calls; the full Electron.BrowserWindow class is not worth doubling.
      () => main as unknown as Electron.BrowserWindow,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeWindow() only needs isDestroyed/webContents.send, which is all forwardHeimdallFleetToRenderer calls; the full Electron.BrowserWindow class is not worth doubling.
      () => dashboard as unknown as Electron.BrowserWindow
    )
    const snapshot = { entries: [], generatedAtMs: 10 }

    listener!(snapshot)

    expect(main.webContents.send).toHaveBeenCalledWith('heimdall:fleetChanged', snapshot)
    expect(dashboard.webContents.send).toHaveBeenCalledWith('heimdall:fleetChanged', snapshot)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not let a destroyed main window suppress the dashboard push', () => {
    let listener: ((snapshot: HeimdallFleetSnapshotReader) => void) | null = null
    const transport = {
      subscribe: (next: (snapshot: HeimdallFleetSnapshotReader) => void) => {
        listener = next
        return vi.fn()
      }
    }
    const main = fakeWindow(true)
    const dashboard = fakeWindow()
    forwardHeimdallFleetToRenderer(
      transport,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeWindow() only needs isDestroyed/webContents.send, which is all forwardHeimdallFleetToRenderer calls; the full Electron.BrowserWindow class is not worth doubling.
      () => main as unknown as Electron.BrowserWindow,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeWindow() only needs isDestroyed/webContents.send, which is all forwardHeimdallFleetToRenderer calls; the full Electron.BrowserWindow class is not worth doubling.
      () => dashboard as unknown as Electron.BrowserWindow
    )

    listener!({ entries: [], generatedAtMs: 11 })

    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(dashboard.webContents.send).toHaveBeenCalledOnce()
  })
})
