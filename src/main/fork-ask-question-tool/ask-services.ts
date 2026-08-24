import { join } from 'node:path'
import { AskDb } from './ask-db'
import { AskRegistry } from './ask-registry'
import { createAskAttachedSurfaceRoster, type AskAttachedSurfaceRoster } from './ask-attached-surface-roster'

export type AskServices = {
  db: AskDb
  registry: AskRegistry
  roster: AskAttachedSurfaceRoster
}

const servicesByRuntime = new WeakMap<object, AskServices>()

/**
 * Lazily builds and memoizes the ask db, registry, and attached-surface roster for one runtime
 * instance, keyed by identity — the runtime itself carries only a one-line delegating accessor.
 */
export function askServicesFor(runtime: object, hasLocalRendererWindow: () => boolean): AskServices {
  let services = servicesByRuntime.get(runtime)
  if (!services) {
    const { app } = require('electron')
    const db = new AskDb(join(app.getPath('userData'), 'asks.db'))
    db.startPeriodicPurge()
    const registry = new AskRegistry(db)
    // Why: RpcContext.clientCapabilities describes only the calling connection, never the
    // surface that owns a pane — the roster needs its own local-window signal to answer that.
    // The registry is also the sink for its own liveness grace timer: a pane losing or
    // regaining its last capable owner is exactly what starts or cancels that timer.
    const roster = createAskAttachedSurfaceRoster(
      { hasLocalRendererWindow },
      {
        notePaneDetached: (paneKey) => registry.notePaneDetached(paneKey),
        notePaneAttached: (paneKey) => registry.notePaneAttached(paneKey)
      }
    )
    services = { db, registry, roster }
    servicesByRuntime.set(runtime, services)
  }
  return services
}
