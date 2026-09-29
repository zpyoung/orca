import { describe, expect, it } from 'vitest'
import { getCommitMessageModel } from '../commit-message-agent-spec'

describe('commit-message launch effort options', () => {
  it('offers codex minimal effort but never leaks it into Copilot --effort', () => {
    expect(getCommitMessageModel('codex', 'gpt-5.5')?.thinkingLevels?.map((l) => l.id)).toContain(
      'minimal'
    )
    // Discovery-synthesized codex ids share the same reasoning-effort flag.
    expect(
      getCommitMessageModel('codex', 'gpt-5.6-sol')?.thinkingLevels?.map((l) => l.id)
    ).toContain('minimal')
    expect(
      getCommitMessageModel('copilot', 'gpt-5-mini')?.thinkingLevels?.map((l) => l.id)
    ).not.toContain('minimal')
  })
})
