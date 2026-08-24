import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAskAttribution } from './ask-pane-attribution'
import { createAskRpcHarness, HANDOFF_PANE_KEY, type AskRpcHarness } from './ask-rpc-test-harness'

const VALID_PANE_KEY = 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('resolveAskAttribution (C3)', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness

  beforeEach(() => {
    h = harness.setup()
  })
  afterEach(() => harness.cleanup())

  it('rule 1: a valid paneKey that resolves to a live pane owns the ask', () => {
    h.setPaneOwner(VALID_PANE_KEY, 'term_1')
    const result = resolveAskAttribution({ paneKey: VALID_PANE_KEY }, h.runtime)
    expect(result.paneKey).toBe(VALID_PANE_KEY)
    expect(result.dispatchLookupHandle).toBe('term_1')
  })

  it('rejects a syntactically invalid paneKey and falls through', () => {
    const result = resolveAskAttribution({ paneKey: 'not-a-pane-key' }, h.runtime)
    expect(result.paneKey).toBeNull()
  })

  it('never trusts a paneKey that does not resolve to a live pane', () => {
    // Why: the server never trusts an env claim without validating it (tech.md C3) — an
    // unproven ORCA_PANE_KEY must not silently win over resolution.
    const result = resolveAskAttribution({ paneKey: VALID_PANE_KEY }, h.runtime)
    expect(result.paneKey).toBeNull()
  })

  it('rule 2: falls back to terminalHandle -> pane when paneKey does not resolve', () => {
    h.setPaneOwner(HANDOFF_PANE_KEY, 'term_2')
    const result = resolveAskAttribution({ terminalHandle: 'term_2' }, h.runtime)
    expect(result.paneKey).toBe(HANDOFF_PANE_KEY)
    expect(result.dispatchLookupHandle).toBe('term_2')
  })

  it('rule 3: worktreeId alone is workspace-scoped with no owning pane', () => {
    const result = resolveAskAttribution({ worktreeId: 'wt_1' }, h.runtime)
    expect(result.paneKey).toBeNull()
    expect(result.worktreeId).toBe('wt_1')
    expect(result.anyIdentityClaimed).toBe(true)
  })

  it('rule 3: workspaceId is accepted as a worktree-equivalent scope', () => {
    const result = resolveAskAttribution({ workspaceId: 'ws_1' }, h.runtime)
    expect(result.worktreeId).toBe('ws_1')
  })

  it('rule 4: nothing claimed resolves to no attribution at all', () => {
    const result = resolveAskAttribution({}, h.runtime)
    expect(result.paneKey).toBeNull()
    expect(result.worktreeId).toBeNull()
    expect(result.dispatchLookupHandle).toBe('')
    expect(result.anyIdentityClaimed).toBe(false)
  })

  it('a terminalHandle that resolves no pane still carries through for the no-UI dispatch lookup', () => {
    const result = resolveAskAttribution({ terminalHandle: 'term_headless', worktreeId: 'wt_2' }, h.runtime)
    expect(result.paneKey).toBeNull()
    expect(result.dispatchLookupHandle).toBe('term_headless')
  })
})
