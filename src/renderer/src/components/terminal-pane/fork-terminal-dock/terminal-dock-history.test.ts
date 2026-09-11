import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { terminalDockHistoryPrompts } from './terminal-dock-history'

function userMessage(text: string, timestamp: number | null): NativeChatMessage {
  return {
    id: `user-${text}`,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function status(): AgentStatusEntry {
  return {
    paneKey: 'tab:leaf',
    agentType: 'claude',
    state: 'working',
    prompt: 'current',
    stateStartedAt: 30,
    updatedAt: 30,
    stateHistory: [
      { state: 'done', prompt: 'older', startedAt: 10 },
      { state: 'waiting', prompt: 'transcript duplicate', startedAt: 20 }
    ]
  }
}

describe('terminalDockHistoryPrompts', () => {
  it('merges sources chronologically and keeps only the newest duplicate', () => {
    expect(
      terminalDockHistoryPrompts(
        [userMessage('transcript duplicate', 5), userMessage('transcript only', 15)],
        status()
      )
    ).toEqual(['older', 'transcript only', 'transcript duplicate', 'current'])
  })

  it('keeps untimestamped transcript prompts in source order before status history', () => {
    expect(
      terminalDockHistoryPrompts(
        [userMessage('first', null), userMessage('second', null)],
        status()
      )
    ).toEqual(['first', 'second', 'older', 'transcript duplicate', 'current'])
  })
})
