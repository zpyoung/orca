/**
 * Pins Claude Code terminal readiness to captured transcripts.
 *
 * Claude Code 2.1.28x paints no OSC title at all — not at cold start, not mid-turn, not after a
 * turn — and draws its screen with cursor moves, so the runtime's newline tail stays empty. The
 * only readiness evidence left is the visible screen, which the tui-idle probe reads.
 *
 * Capture protocol: docs/reference/agent-pty-transcript-capture.md
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const ESC = String.fromCharCode(27)

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8')
}

/** The visible screen as the provider snapshot returns it, at the size the capture recorded. */
async function renderVisibleScreen(transcript: string): Promise<string[]> {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(transcript, resolve))
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }
  terminal.dispose()
  return lines
}

describe('Claude Code ready prompt, decided by captured transcripts', () => {
  const cases = [
    { name: 'claude-code-ready-cold-start', ready: true },
    { name: 'claude-code-busy-mid-turn', ready: false },
    // Idle, but with no placeholder and no title there is no positive evidence to settle on.
    { name: 'claude-code-idle-after-turn', ready: false }
  ] as const

  for (const transcript of cases) {
    it(`${transcript.name} → ${transcript.ready ? 'ready' : 'not ready'}`, async () => {
      const raw = readFixture(transcript.name)
      expect(raw).toContain(ESC)
      const screen = await renderVisibleScreen(raw)
      expect(isKnownReadyPromptPreview(screen.join('\n'))).toBe(transcript.ready)
    })
  }
})

describe('Claude Code tui-idle wait at cold start', () => {
  it('keeps probing the visible screen until Claude has painted its prompt', async () => {
    const readyScreen = await renderVisibleScreen(readFixture('claude-code-ready-cold-start'))
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'claude',
      foregroundProcess: 'claude',
      data: ''
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches the runtime's pty map to mark the pane as an Orca-launched Claude, as worker-start does.
    const internals = runtime as unknown as { ptysById: Map<string, { launchAgent?: string }> }
    internals.ptysById.get(TRANSCRIPT_PANE_PTY_ID)!.launchAgent = 'claude'
    let reads = 0
    // The first read lands before Claude has drawn anything, as a worker start's does.
    vi.spyOn(runtime, 'readTerminal').mockImplementation(async () => {
      reads += 1
      return { source: 'screen', tail: reads === 1 ? [] : readyScreen } as never
    })

    const result = (await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })) as { satisfied?: boolean }

    expect(result.satisfied).toBe(true)
    expect(reads).toBeGreaterThan(1)
  }, 15_000)
})
