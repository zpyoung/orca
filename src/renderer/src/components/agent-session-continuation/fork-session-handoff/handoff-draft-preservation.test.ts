import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearHandoffDraft,
  getHandoffDraftSourceKey,
  preserveHandoffDraft,
  restoreHandoffDraft,
  type HandoffDraftSourceIdentity,
  type PreservedHandoffDraft
} from './handoff-draft-preservation'

const paneSource: HandoffDraftSourceIdentity = {
  sourcePaneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  vaultAgent: null,
  vaultSessionId: null
}
const vaultSource: HandoffDraftSourceIdentity = {
  sourcePaneKey: null,
  vaultAgent: 'claude',
  vaultSessionId: 'session-1'
}
const draft: PreservedHandoffDraft = {
  steeringNote: 'Check the failing test',
  includeToggles: { repoState: true, diffBodies: false, openEditorTabs: true },
  templateId: 'review',
  selectedAgent: 'codex',
  targetWorktreeId: 'worktree-2',
  preview: {
    phase: 'detached',
    editedBody: 'Edited handoff',
    staleReasons: ['controls-changed']
  }
}

beforeEach(() => {
  clearHandoffDraft(paneSource)
  clearHandoffDraft(vaultSource)
})

describe('handoff draft preservation', () => {
  it('keys pane and vault sources independently', () => {
    expect(getHandoffDraftSourceKey(paneSource)).toBe(paneSource.sourcePaneKey)
    expect(getHandoffDraftSourceKey(vaultSource)).toBe('vault:claude:session-1')
    expect(
      getHandoffDraftSourceKey({ sourcePaneKey: null, vaultAgent: null, vaultSessionId: null })
    ).toBeNull()
  })

  it('restores drafts only for the same source', () => {
    expect(preserveHandoffDraft(paneSource, draft)).toBe(true)

    expect(restoreHandoffDraft(paneSource)).toEqual(draft)
    expect(restoreHandoffDraft(vaultSource)).toBeNull()
  })

  it('stores and returns isolated snapshots', () => {
    preserveHandoffDraft(paneSource, draft)
    const restored = restoreHandoffDraft(paneSource)
    if (!restored || restored.preview.phase !== 'detached') {
      throw new Error('expected detached draft')
    }

    restored.includeToggles.repoState = false
    restored.preview.staleReasons.push('target-changed')

    expect(restoreHandoffDraft(paneSource)).toEqual(draft)
  })

  it('clears a successful source without affecting another source', () => {
    preserveHandoffDraft(paneSource, draft)
    preserveHandoffDraft(vaultSource, { ...draft, steeringNote: 'Vault draft' })

    expect(clearHandoffDraft(paneSource)).toBe(true)
    expect(restoreHandoffDraft(paneSource)).toBeNull()
    expect(restoreHandoffDraft(vaultSource)?.steeringNote).toBe('Vault draft')
  })

  it('does not retain an unidentifiable source', () => {
    const unknown = { sourcePaneKey: null, vaultAgent: null, vaultSessionId: null }

    expect(preserveHandoffDraft(unknown, draft)).toBe(false)
    expect(restoreHandoffDraft(unknown)).toBeNull()
    expect(clearHandoffDraft(unknown)).toBe(false)
  })
})
