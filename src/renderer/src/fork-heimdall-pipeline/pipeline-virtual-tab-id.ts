const PIPELINE_TAB_ID_PATTERN =
  /^heimdall-pipeline:\/\/(?:repo|builtin|user)\/[^/]+\/[a-z][a-z0-9-]{0,62}$/u

/** Identify saved unified-tab rows whose virtual canvas is intentionally transient on restart. */
export function isPipelineVirtualTabId(tabId: string): boolean {
  if (!PIPELINE_TAB_ID_PATTERN.test(tabId)) {
    return false
  }
  try {
    const worktreeSegment = tabId.split('/')[3]
    return worktreeSegment !== undefined && decodeURIComponent(worktreeSegment).length > 0
  } catch {
    return false
  }
}
