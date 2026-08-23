import { describe, expect, it } from 'vitest'
import { RelayDispatcher, type RelayClientSinkOptions } from '../dispatcher'
import { publishAgentHookEnvelope } from '../agent-hook-envelope-publication'
import { AGENT_HOOK_NOTIFICATION_METHOD } from '../../shared/agent-hook-relay'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import {
  APPROVAL_FULL_INPUT_MAX_LENGTH,
  approvalFullInputFields
} from '../../shared/fork-approval-full-command/approval-full-input'

type Client = {
  frames: Buffer[]
  write: (data: Buffer) => boolean
  options: RelayClientSinkOptions
}

function makeClient(highWaterMark: number): Client {
  const frames: Buffer[] = []
  return {
    frames,
    write: (data: Buffer) => {
      frames.push(Buffer.from(data))
      return true
    },
    options: {
      writableHighWaterMark: () => highWaterMark,
      writableLength: () => 0,
      waitWriteDrain: () => () => {},
      close: () => {}
    }
  }
}

function approvalEnvelope(command: string): AgentHookRelayEnvelope {
  const summary = command.length > 200 ? `${command.slice(0, 200)}…` : command
  return {
    source: 'claude',
    paneKey: 'tab-1:4f1b0f4e-0000-4000-8000-000000000001',
    connectionId: null,
    worktreeId: 'worktree-1',
    payload: {
      state: 'waiting',
      prompt: 'p'.repeat(64),
      agentType: 'claude',
      model: 'claude-opus',
      toolName: 'Bash',
      toolInput: summary,
      interactivePrompt: JSON.stringify({
        approval: {
          tool: 'Bash',
          summary,
          ...approvalFullInputFields({ command }, summary)
        }
      })
    }
  }
}

function publishedApprovals(
  client: Client
): { summary?: string; full?: string; fullLength?: number }[] {
  return client.frames
    .filter((frame) => frame.readUInt32BE(9) > 0)
    .map((frame) => JSON.parse(frame.subarray(13, 13 + frame.readUInt32BE(9)).toString('utf-8')))
    .filter((msg) => msg.method === AGENT_HOOK_NOTIFICATION_METHOD)
    .map((msg) =>
      JSON.parse((msg.params as AgentHookRelayEnvelope).payload.interactivePrompt ?? '{}')
    )
    .map((prompt) => prompt.approval ?? {})
}

describe('approval envelopes over a bounded relay frame', () => {
  // A `waiting` snapshot the relay cannot fit is dropped whole, leaving web and mobile with no
  // card to answer — strictly worse than the truncated one the fork's `full` field replaced.
  it('still delivers an answerable card when the untruncated command will not fit', () => {
    const client = makeClient(16384)
    const dispatcher = new RelayDispatcher(client.write, client.options)
    try {
      publishAgentHookEnvelope(dispatcher, approvalEnvelope('\n'.repeat(6000)))
      const approvals = publishedApprovals(client)
      expect(approvals).toHaveLength(1)
      expect(approvals[0].summary).toBeTruthy()
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps the true length intact when it compacts the text, so the client can say so', () => {
    const client = makeClient(16384)
    const dispatcher = new RelayDispatcher(client.write, client.options)
    try {
      const command = '\n'.repeat(6000)
      publishAgentHookEnvelope(dispatcher, approvalEnvelope(command))
      const [approval] = publishedApprovals(client)
      expect(approval.fullLength).toBe(command.length)
      expect(approval.full!.length).toBeLessThan(approval.fullLength!)
    } finally {
      dispatcher.dispose()
    }
  })

  it('leaves a command that already fits untouched', () => {
    const client = makeClient(65536)
    const dispatcher = new RelayDispatcher(client.write, client.options)
    try {
      const command = 'echo '.repeat(60)
      publishAgentHookEnvelope(dispatcher, approvalEnvelope(command))
      const [approval] = publishedApprovals(client)
      expect(approval.full).toBe(command)
      expect(approval.fullLength).toBe(command.length)
      expect(command.length).toBeLessThan(APPROVAL_FULL_INPUT_MAX_LENGTH)
    } finally {
      dispatcher.dispose()
    }
  })
})
