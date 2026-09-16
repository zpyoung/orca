import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/omp-atomic-submit',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/omp-atomic-submit',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const PTY_ID = 'pty-prompt'

/** Models the observable OMP large-paste decision without importing an installed CLI package.
 * OMP accepts a trailing submit from the same input burst as the completed paste; otherwise it
 * opens the large-paste menu, whose first keypress consumes a later bare CR. */
function createOmpLargePasteHarness(onSubmit: (prompt: string) => void): {
  ingest: (data: string) => void
  submissions: string[]
  menuOpens: () => number
} {
  const submissions: string[] = []
  let menuOpen = false
  let menuOpens = 0
  return {
    ingest: (data) => {
      const start = data.indexOf(AGENT_PROMPT_BRACKETED_PASTE_START)
      if (start === -1) {
        if (menuOpen && data === AGENT_PROMPT_SUBMIT) {
          menuOpen = false
        }
        return
      }
      const contentStart = start + AGENT_PROMPT_BRACKETED_PASTE_START.length
      const end = data.indexOf(AGENT_PROMPT_BRACKETED_PASTE_END, contentStart)
      if (end === -1) {
        return
      }
      const prompt = data.slice(contentStart, end)
      const trailing = data.slice(end + AGENT_PROMPT_BRACKETED_PASTE_END.length)
      if (trailing === AGENT_PROMPT_SUBMIT) {
        submissions.push(prompt)
        onSubmit(prompt)
        return
      }
      menuOpen = true
      menuOpens += 1
    },
    submissions,
    menuOpens: () => menuOpens
  }
}

afterEach(() => {
  vi.useRealTimers()
  agentSessionPtyWriteGate.detachRecordLookup()
})

describe('OMP agent prompt submission', () => {
  it('atomically accepts a large paste and observes a turn started during that write', async () => {
    const prompt = Array.from(
      { length: 120 },
      (_, index) => `line ${index}: ${'x'.repeat(48)}`
    ).join('\n')
    let runtime: OrcaRuntimeService
    const omp = createOmpLargePasteHarness(() => {
      // The provider can report its turn synchronously from the write callback. The verification
      // baseline must predate the atomic write or this real transition is missed as stale state.
      runtime.onPtyData(PTY_ID, '\x1b]9999;{"state":"working","agentType":"omp"}\x07', Date.now())
    })
    const created = await createAgentPromptSubmissionRuntime(
      (_runtime, data) => omp.ingest(data),
      'omp'
    )
    runtime = created.runtime

    await expect(runtime.sendTerminalAgentPrompt(created.handle, prompt)).resolves.toMatchObject({
      accepted: true
    })

    expect(omp.submissions).toEqual([prompt])
    expect(omp.menuOpens()).toBe(0)
    expect(created.writes).toEqual([`${buildAgentPromptPasteBytes(prompt)}${AGENT_PROMPT_SUBMIT}`])
  })

  it('records the queued receipt baseline before a same-write OMP lifecycle transition', async () => {
    const created = await createAgentPromptSubmissionRuntime((runtime) => {
      runtime.onPtyData(PTY_ID, '\x1b]9999;{"state":"working","agentType":"omp"}\x07', Date.now())
    }, 'omp')

    await expect(
      created.runtime.sendTerminalAgentPrompt(created.handle, 'inspect the receipt', {
        acceptQueued: true,
        requestId: 'omp-atomic-receipt'
      })
    ).resolves.toMatchObject({
      prompt: {
        stages: ['input_accepted'],
        baselineWorkingSequence: 0
      }
    })
    expect(created.writes).toEqual([
      `${buildAgentPromptPasteBytes('inspect the receipt')}${AGENT_PROMPT_SUBMIT}`
    ])
  })

  it('rechecks cancellation and permission safety before the atomic write', async () => {
    const cancelled = new AbortController()
    const cancelledRuntime = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')
    await expect(
      cancelledRuntime.runtime.sendTerminalAgentPrompt(cancelledRuntime.handle, 'cancel me', {
        signal: cancelled.signal,
        beforeWrite: () => cancelled.abort()
      })
    ).rejects.toThrow('request_aborted')
    expect(cancelledRuntime.writes).toEqual([])

    const permissionRuntime = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')
    await expect(
      permissionRuntime.runtime.sendTerminalAgentPrompt(permissionRuntime.handle, 'do not paste', {
        beforeWrite: () => {
          permissionRuntime.runtime.onPtyData(
            PTY_ID,
            '\x1b]9999;{"state":"waiting","agentType":"omp"}\x07',
            Date.now()
          )
        }
      })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(permissionRuntime.writes).toEqual([])
  })

  it('rechecks the PTY generation before the atomic write', async () => {
    const created = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')

    await expect(
      created.runtime.sendTerminalAgentPrompt(created.handle, 'stay on this process', {
        beforeWrite: () => {
          created.runtime.synchronizePtyOutputSequenceFromProvider(
            PTY_ID,
            { value: 0, generation: 'reset' },
            created.runtime.getPtyOutputSequence(PTY_ID)
          )
        }
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(created.writes).toEqual([])
  })

  it('rechecks the admitted session fence before the atomic write', async () => {
    let record: AgentSessionRecord = agentSessionRecordFixture(agentSessionLeaseFixture())
    const created = await createAgentPromptSubmissionRuntime(() => undefined, 'omp')
    agentSessionPtyWriteGate.attachRecordLookup(() => record)
    agentSessionPtyWriteGate.bindPty(PTY_ID, record.sessionId)

    await expect(
      created.runtime.sendTerminalAgentPrompt(created.handle, 'respect the owner', {
        beforeWrite: () => {
          record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 8 }))
        }
      })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    expect(created.writes).toEqual([])
  })

  it('keeps non-OMP submission delayed and emits exactly one separate CR', async () => {
    vi.useFakeTimers()
    const prompt = 'review this change'
    const created = await createAgentPromptSubmissionRuntime((runtime, data) => {
      if (data === AGENT_PROMPT_SUBMIT) {
        runtime.onPtyData(
          PTY_ID,
          '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
          Date.now()
        )
      }
    }, 'aider')
    const delayMs = getAgentPromptSubmitDelayMs(
      process.platform,
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )

    const submission = created.runtime.sendTerminalAgentPrompt(created.handle, prompt)
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(created.writes).toEqual([buildAgentPromptPasteBytes(prompt)])

    await vi.advanceTimersByTimeAsync(1)
    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(created.writes).toEqual([buildAgentPromptPasteBytes(prompt), AGENT_PROMPT_SUBMIT])
  })
})
