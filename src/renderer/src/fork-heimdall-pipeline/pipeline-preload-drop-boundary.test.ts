// @vitest-environment happy-dom

import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PIPELINE_NODE_DRAG_TYPE } from './PipelinePalette'

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn((file: { name: string }) => `/repro/${file.name}`)
}))

vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))

let sandbox: Window

type DropTransfer = { types: string[]; files: File[]; dropEffect: string }

function dispatchDropEvent(
  target: HTMLElement,
  type: 'dragover' | 'drop',
  types: string[],
  files: File[] = []
): { event: Event; transfer: DropTransfer } {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const transfer: DropTransfer = { types, files, dropEffect: 'none' }
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  target.dispatchEvent(event)
  return { event, transfer }
}

describe('pipeline preload drop boundary', () => {
  beforeEach(async () => {
    vi.resetModules()
    electron.on.mockReset()
    electron.removeListener.mockReset()
    electron.send.mockReset()
    electron.getPathForFile.mockReset().mockImplementation((file) => `/repro/${file.name}`)

    sandbox = new Window()
    vi.stubGlobal('window', sandbox)
    vi.stubGlobal('document', sandbox.document)
    vi.stubGlobal('HTMLElement', sandbox.HTMLElement)
    vi.stubGlobal('Event', sandbox.Event)
    vi.stubGlobal('File', sandbox.File)

    // A static import would retain install state for the prior document; reload per sandbox.
    const { installNativeFileDropHandlers } =
      await import('../../../preload/preload-runtime-support')
    installNativeFileDropHandlers()
  })

  afterEach(async () => {
    await sandbox.happyDOM.close()
    vi.unstubAllGlobals()
  })

  it('lets pipeline node drags reach the canvas while leaving cancellation to the target', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const preloadDragoverStates: boolean[] = []
    const preloadDropStates: boolean[] = []
    document.addEventListener(
      'dragover',
      (event) => preloadDragoverStates.push(event.defaultPrevented),
      true
    )
    document.addEventListener(
      'drop',
      (event) => preloadDropStates.push(event.defaultPrevented),
      true
    )

    const receivedEvents: string[] = []
    target.addEventListener('dragover', (event) => {
      receivedEvents.push('dragover')
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move'
      }
    })
    target.addEventListener('drop', (event) => {
      receivedEvents.push('drop')
      event.preventDefault()
    })

    const dragover = dispatchDropEvent(target, 'dragover', [PIPELINE_NODE_DRAG_TYPE])
    const drop = dispatchDropEvent(target, 'drop', [PIPELINE_NODE_DRAG_TYPE])

    expect(receivedEvents).toEqual(['dragover', 'drop'])
    expect(preloadDragoverStates).toEqual([false])
    expect(preloadDropStates).toEqual([false])
    expect(dragover.transfer.dropEffect).toBe('move')
    // The canvas prevents the drop after receiving it; preload must not cancel first.
    expect(drop.event.defaultPrevented).toBe(true)
  })

  it('keeps native Files intercepted before reaching the target', () => {
    const target = document.createElement('div')
    target.dataset.nativeFileDropTarget = 'editor'
    document.body.append(target)
    let deliveredToTarget = false
    target.addEventListener('drop', () => {
      deliveredToTarget = true
    })

    const dragover = dispatchDropEvent(target, 'dragover', ['Files'])
    const drop = dispatchDropEvent(target, 'drop', ['Files'], [new File(['pipeline'], 'flow.json')])

    expect(dragover.event.defaultPrevented).toBe(true)
    expect(dragover.transfer.dropEffect).toBe('copy')
    expect(drop.event.defaultPrevented).toBe(true)
    expect(drop.event.cancelBubble).toBe(true)
    expect(deliveredToTarget).toBe(false)
  })
})
