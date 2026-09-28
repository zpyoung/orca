/**
 * Re-exports the structured-worker-session primitives the owner runtime holds across a watcher's
 * lifetime. Kept in this directory, not `owner/`, because every import of `runtime/rpc/methods`
 * orchestration internals is confined here — see `orchestration-import-boundary.test.ts`.
 */
export {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession,
  sendStructuredWorkerPreamble
} from '../../runtime/rpc/methods/orchestration-structured-worker-session'
