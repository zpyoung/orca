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
    // Why: RpcContext.clientCapabilities describes only the calling connection, never the
    // surface that owns a pane — the roster needs its own local-window signal to answer that.
    const roster = createAskAttachedSurfaceRoster({ hasLocalRendererWindow })
    services = { db, registry: new AskRegistry(db), roster }
    servicesByRuntime.set(runtime, services)
  }
  return services
}
