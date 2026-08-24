import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { askServicesFor } from './ask-services'
import { ASK_LIVENESS_GRACE_MS } from './ask-registry'
import { ASK_SURFACE_CLIENT_CAPABILITY } from '../../shared/fork-ask-question-tool/ask-question-capability'

// Why: ask-services.ts resolves the electron app lazily via require('electron') (mirroring
// getOrchestrationDb) rather than a static import, so outside a real Electron process
// require('electron') just returns the binary's path string — stub the module's own
// require.cache entry, since vi.mock only intercepts the ESM import graph.
const require = createRequire(import.meta.url)
const electronModulePath = require.resolve('electron')
const mockElectronApp = { userDataPath: '' }

require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { getPath: () => mockElectronApp.userDataPath } }
} as unknown as NodeJS.Module

describe('askServicesFor', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-ask-services-'))
    mockElectronApp.userDataPath = root
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('does not construct the ask db until first called for a runtime key, then memoizes it', () => {
    const runtimeKey = {}
    const dbPath = join(root, 'asks.db')

    expect(existsSync(dbPath)).toBe(false)

    const services = askServicesFor(runtimeKey, () => false)
    expect(existsSync(dbPath)).toBe(true)
    expect(askServicesFor(runtimeKey, () => false)).toBe(services)
  })

  it('builds the registry over the same db and keeps both stable across calls', async () => {
    const runtimeKey = {}

    const { db, registry } = askServicesFor(runtimeKey, () => false)
    const second = askServicesFor(runtimeKey, () => false)
    expect(second.db).toBe(db)
    expect(second.registry).toBe(registry)

    const { askId } = await registry.register(
      { questions: [{ id: 'q1', type: 'text', question: 'Q1?' }] },
      { paneKey: 'pane:1', worktreeId: null },
      { requestId: 'req_1' }
    )
    expect(db.getAsk(askId)).toBeTruthy()
  })

  it('keeps separate service bundles for separate runtime keys', () => {
    const services1 = askServicesFor({}, () => false)
    const services2 = askServicesFor({}, () => false)
    expect(services1).not.toBe(services2)
    expect(services1.db).not.toBe(services2.db)
  })

  it('wires the roster to the hasLocalRendererWindow callback given at first construction', () => {
    const runtimeKey = {}
    const { roster } = askServicesFor(runtimeKey, () => true)
    expect(roster.hasCapableOwner('pane:never-subscribed')).toBe(true)
  })

  describe('liveness wiring', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('resolves unavailable once the roster reports the last capable owner detached and the grace window elapses', async () => {
      vi.useFakeTimers()
      const { registry, roster, db } = askServicesFor({}, () => false)
      roster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
      roster.trackPaneSubscription('conn-1', 'pane:1')

      const { askId } = await registry.register(
        { questions: [{ id: 'q1', type: 'text', question: 'Q1?' }] },
        { paneKey: 'pane:1', worktreeId: null },
        { requestId: 'req_1' }
      )

      // Driven through the roster's own subscription bookkeeping, not by calling
      // registry.notePaneDetached directly.
      roster.untrackPaneSubscription('conn-1', 'pane:1')
      await vi.advanceTimersByTimeAsync(ASK_LIVENESS_GRACE_MS)

      expect(db.getAsk(askId)?.status).toBe('unavailable')
    })

    it('cancels the grace timer when the roster reports the pane reattached inside the window', async () => {
      vi.useFakeTimers()
      const { registry, roster, db } = askServicesFor({}, () => false)
      roster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
      roster.trackPaneSubscription('conn-1', 'pane:1')

      const { askId } = await registry.register(
        { questions: [{ id: 'q1', type: 'text', question: 'Q1?' }] },
        { paneKey: 'pane:1', worktreeId: null },
        { requestId: 'req_1' }
      )

      roster.untrackPaneSubscription('conn-1', 'pane:1')
      await vi.advanceTimersByTimeAsync(ASK_LIVENESS_GRACE_MS - 1_000)
      roster.trackPaneSubscription('conn-1', 'pane:1')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(db.getAsk(askId)?.status).toBe('registered')
    })
  })
})
