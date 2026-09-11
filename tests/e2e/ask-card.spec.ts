import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { AskRegistryEvent } from '../../src/shared/fork-ask-question-tool/ask-question-schema'

type RpcCall = { method: string; params?: unknown }

/** Mirrors `ASK_DISMISS_DELAY_MS` in the asks slice; imported as a literal because the slice pulls
 * renderer-only aliases that do not resolve in the Playwright process. */
const ASK_DISMISS_DELAY_MS = 4000

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __askRpcCalls?: RpcCall[]
  }
}

async function setupAskPane(page: Page): Promise<{ paneKey: string }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  return waitForActivePaneHookDescriptor(page)
}

/** The sidebar route the ask panel is showing, plus the tab the user's own route still points at
 * — the override must never write itself into the second one. */
async function readSidebarRoute(page: Page): Promise<{ stored: string; open: boolean }> {
  return page.evaluate(() => ({
    stored: String(window.__store?.getState().rightSidebarTab),
    open: Boolean(window.__store?.getState().rightSidebarOpen)
  }))
}

/** Directly seeds a pending, single-text-question ask onto a pane, mirroring the registry event
 * that would otherwise arrive over `ask:set` IPC. */
async function seedPendingAsk(
  page: Page,
  args: { paneKey: string; askId: string; questionId: string; question: string }
): Promise<void> {
  await page.evaluate(({ paneKey, askId, questionId, question }) => {
    window.__store?.setState((state) => ({
      pendingAsksByPaneKey: {
        ...state.pendingAsksByPaneKey,
        [paneKey]: [
          {
            askId,
            paneKey,
            status: 'pending',
            spec: { questions: [{ id: questionId, type: 'text', question }] },
            partial: {}
          }
        ]
      }
    }))
  }, args)
}

/** Applies the terminal transition a real backend would push once an answer commits — this
 * suite has no live agent to register a real ask against, so the round trip is simulated here. */
async function resolveSeededAsk(
  page: Page,
  args: { paneKey: string; askId: string; summary: string }
): Promise<void> {
  await page.evaluate(({ paneKey, askId, summary }) => {
    window.__store?.setState((state) => ({
      pendingAsksByPaneKey: {
        ...state.pendingAsksByPaneKey,
        [paneKey]: (state.pendingAsksByPaneKey[paneKey] ?? []).map((card) =>
          card.askId === askId
            ? {
                ...card,
                status: 'answered' as const,
                result: { answers: {}, skipped: [], summary }
              }
            : card
        )
      }
    }))
  }, args)
}

/** Pushes an event through the real `applyAskRegistryEvent` reducer. `seedPendingAsk` writes store
 * state directly, so it never arms the terminal auto-dismiss the reducer owns. */
async function applyAskEvent(page: Page, event: AskRegistryEvent): Promise<void> {
  await page.evaluate((registryEvent) => {
    window.__store?.setState({
      askWatermark: { seq: registryEvent.seq - 1, epoch: registryEvent.epoch },
      _askEventBuffer: []
    })
    window.__store?.getState().applyAskRegistryEvent(registryEvent)
  }, event)
}

function textAsk(args: {
  seq: number
  epoch: string
  askId: string
  paneKey: string
  questionId: string
  question: string
}): AskRegistryEvent {
  return {
    seq: args.seq,
    epoch: args.epoch,
    askId: args.askId,
    paneKey: args.paneKey,
    status: 'pending',
    spec: { questions: [{ id: args.questionId, type: 'text', question: args.question }] },
    partial: {}
  }
}

async function installAskRpcRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__askRpcCalls = []
    const original = window.api.runtime.call
    window.api.runtime.call = (args) => {
      window.__askRpcCalls?.push(args)
      return original(args)
    }
  })
}

async function getRecordedAskRpcCalls(page: Page): Promise<RpcCall[]> {
  return page.evaluate(() => window.__askRpcCalls ?? [])
}

/** Makes `ask.snapshot` return a canned result while every other RPC call passes through
 * untouched — the seam that lets a hydration replay be driven without a real backend row. */
async function mockAskSnapshotResponse(
  page: Page,
  snapshot: { asks: AskRegistryEvent[]; seq: number; epoch: string }
): Promise<void> {
  await page.evaluate((snapshotResult) => {
    const original = window.api.runtime.call
    window.api.runtime.call = (args) => {
      if (args.method === 'ask.snapshot') {
        return Promise.resolve({
          id: 'e2e-ask-snapshot',
          ok: true as const,
          result: snapshotResult,
          _meta: { runtimeId: 'e2e' }
        })
      }
      return original(args)
    }
  }, snapshot)
}

/** Renderer-remount seam: clears the slice back to its pre-hydration shape, then replays the real
 * `hydrateAsks()` against whatever `ask.snapshot` response is currently installed. */
async function replayAskHydration(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.setState({ pendingAsksByPaneKey: {}, askWatermark: null, _askEventBuffer: [] })
  })
  await page.evaluate(() => window.__store?.getState().hydrateAsks())
}

test.describe('Ask card', () => {
  test('takes the right sidebar for a pending ask on the focused pane', async ({ orcaPage }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const askId = `e2e-ask-render-${randomUUID()}`
    const question = 'Ready to deploy the release build?'
    const before = await readSidebarRoute(orcaPage)

    await seedPendingAsk(orcaPage, { paneKey, askId, questionId: 'q1', question })

    await expect(orcaPage.getByText(question)).toBeVisible({ timeout: 10_000 })
    await expect(orcaPage.getByRole('textbox', { name: question })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Questions/ })).toBeVisible()

    // The override renders the panel without touching the persisted route, so the tab the user
    // chose is still the one on record while the question is up.
    const during = await readSidebarRoute(orcaPage)
    expect(during.open).toBe(true)
    expect(during.stored).toBe(before.stored)
    expect(during.stored).not.toBe('ask')
  })

  test('gives the sidebar back to the previous tab once the ask clears', async ({ orcaPage }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const epoch = `e2e-handback-${randomUUID()}`
    const askId = `e2e-ask-handback-${randomUUID()}`
    const question = 'Retire the old stack?'

    await orcaPage.evaluate(() => window.__store?.getState().setRightSidebarTab('source-control'))
    await applyAskEvent(
      orcaPage,
      textAsk({ seq: 1, epoch, askId, paneKey, questionId: 'q1', question })
    )
    await expect(orcaPage.getByRole('textbox', { name: question })).toBeVisible({ timeout: 10_000 })

    await applyAskEvent(orcaPage, {
      seq: 2,
      epoch,
      askId,
      paneKey,
      status: 'declined',
      partial: {},
      result: { answers: {}, skipped: ['q1'], summary: 'Declined.' }
    })

    // The rail item outlives the answer by ASK_DISMISS_DELAY_MS so the summary can be read.
    await expect(orcaPage.getByRole('button', { name: /Questions/ })).toHaveCount(0, {
      timeout: ASK_DISMISS_DELAY_MS + 10_000
    })
    expect((await readSidebarRoute(orcaPage)).stored).toBe('source-control')
  })

  test('answering resolves the blocked wait and collapses the card', async ({ orcaPage }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const askId = `e2e-ask-answer-${randomUUID()}`
    const questionId = 'q1'
    const question = 'What should the release notes say?'
    const answerText = 'Fixed the release build pipeline.'

    await seedPendingAsk(orcaPage, { paneKey, askId, questionId, question })
    const field = orcaPage.getByRole('textbox', { name: question })
    await expect(field).toBeVisible({ timeout: 10_000 })
    await field.fill(answerText)

    await installAskRpcRecorder(orcaPage)
    await orcaPage.getByRole('button', { name: 'Submit' }).click()

    await expect
      .poll(
        async () =>
          (await getRecordedAskRpcCalls(orcaPage)).some((call) => call.method === 'ask.answer'),
        {
          timeout: 10_000,
          message: 'submit did not reach the ask.answer RPC call'
        }
      )
      .toBe(true)
    const answerCall = (await getRecordedAskRpcCalls(orcaPage)).find(
      (call) => call.method === 'ask.answer'
    )
    expect(answerCall?.params).toEqual({
      askId,
      answers: { [questionId]: { value: answerText, source: 'input' } },
      skipped: []
    })

    await resolveSeededAsk(orcaPage, { paneKey, askId, summary: 'Answered.' })

    await expect(orcaPage.getByText(question)).toHaveCount(0, { timeout: 10_000 })
    await expect(orcaPage.getByText('Answered.')).toBeVisible()
  })

  test('restores a pending ask with its partial draft intact after a renderer remount', async ({
    orcaPage
  }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const askId = `e2e-ask-restart-${randomUUID()}`
    const questionId = 'q1'
    const question = 'Which branch should this ship from?'
    const draftText = 'release/1.4 pending one more fix'

    const snapshotEvent: AskRegistryEvent = {
      seq: 1,
      epoch: 'e2e-restart-epoch',
      askId,
      paneKey,
      status: 'pending',
      spec: { questions: [{ id: questionId, type: 'text', question }] },
      partial: { [questionId]: { draft: draftText } }
    }
    await mockAskSnapshotResponse(orcaPage, {
      asks: [snapshotEvent],
      seq: 1,
      epoch: 'e2e-restart-epoch'
    })

    await replayAskHydration(orcaPage)

    // The regression this guards: a card that merely exists post-restart is not enough — the
    // hydrated draft must reach the field, or the user's in-progress answer is silently lost.
    const field = orcaPage.getByRole('textbox', { name: question })
    await expect(field).toBeVisible({ timeout: 10_000 })
    await expect(field).toHaveValue(draftText)
  })

  test('clears a resolved card and surfaces the next queued ask on its own', async ({
    orcaPage
  }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const epoch = `e2e-dismiss-${randomUUID()}`
    const first = 'Should the old stack be retired?'
    const second = 'Which region goes first?'
    const askId = `e2e-ask-first-${randomUUID()}`

    await applyAskEvent(
      orcaPage,
      textAsk({ seq: 1, epoch, askId, paneKey, questionId: 'q1', question: first })
    )
    await applyAskEvent(
      orcaPage,
      textAsk({
        seq: 2,
        epoch,
        askId: `e2e-ask-second-${randomUUID()}`,
        paneKey,
        questionId: 'q2',
        question: second
      })
    )

    await expect(orcaPage.getByRole('textbox', { name: first })).toBeVisible({ timeout: 10_000 })
    await expect(orcaPage.getByRole('textbox', { name: second })).toHaveCount(0)

    await applyAskEvent(orcaPage, {
      seq: 3,
      epoch,
      askId,
      paneKey,
      status: 'declined',
      partial: {},
      result: { answers: {}, skipped: ['q1'], summary: 'Declined.' }
    })

    await expect(orcaPage.getByText('Declined.')).toBeVisible({ timeout: 10_000 })
    // The regression this guards: the resolved card used to sit at the head forever, so the
    // already-queued second ask was never shown.
    await expect(orcaPage.getByRole('textbox', { name: second })).toBeVisible({
      timeout: ASK_DISMISS_DELAY_MS + 10_000
    })
    await expect(orcaPage.getByText('Declined.')).toHaveCount(0)
  })

  test('scrolls a full ten-question card instead of growing past the panel', async ({
    orcaPage
  }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const askId = `e2e-ask-tall-${randomUUID()}`

    await orcaPage.evaluate(
      ({ pane, id }) => {
        window.__store?.setState((state) => ({
          pendingAsksByPaneKey: {
            ...state.pendingAsksByPaneKey,
            [pane]: [
              {
                askId: id,
                paneKey: pane,
                status: 'pending',
                spec: {
                  questions: Array.from({ length: 10 }, (_, index) => ({
                    id: `q${index}`,
                    type: 'text' as const,
                    question: `Tall card question ${index}?`
                  }))
                },
                partial: {}
              }
            ]
          }
        }))
      },
      { pane: paneKey, id: askId }
    )

    await expect(orcaPage.getByRole('textbox', { name: 'Tall card question 0?' })).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByRole('button', { name: 'Submit' })).toBeVisible()

    const metrics = await orcaPage.evaluate(() => {
      const submit = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Submit'
      )
      // Walk up to the card root rather than matching a utility class, so the assertion does
      // not re-break the next time the shell's classes change.
      let node = submit?.parentElement ?? null
      while (node && !node.querySelector('.overflow-y-auto')) {
        node = node.parentElement
      }
      const body = node?.querySelector<HTMLElement>('.overflow-y-auto')
      return body ? { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null
    })

    expect(metrics).not.toBeNull()
    expect(metrics!.scrollHeight).toBeGreaterThan(metrics!.clientHeight)
  })
})
