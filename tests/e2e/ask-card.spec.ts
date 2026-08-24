import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { AskRegistryEvent } from '../../src/shared/fork-ask-question-tool/ask-question-schema'

type RpcCall = { method: string; params?: unknown }

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
            ? { ...card, status: 'answered' as const, result: { answers: {}, skipped: [], summary } }
            : card
        )
      }
    }))
  }, args)
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
  test('renders a card in the pane when a pending ask is seeded', async ({ orcaPage }) => {
    const { paneKey } = await setupAskPane(orcaPage)
    const askId = `e2e-ask-render-${randomUUID()}`
    const question = 'Ready to deploy the release build?'

    await seedPendingAsk(orcaPage, { paneKey, askId, questionId: 'q1', question })

    await expect(orcaPage.getByText(question)).toBeVisible({ timeout: 10_000 })
    await expect(orcaPage.getByRole('textbox', { name: question })).toBeVisible()
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
      .poll(async () => (await getRecordedAskRpcCalls(orcaPage)).some((call) => call.method === 'ask.answer'), {
        timeout: 10_000,
        message: 'submit did not reach the ask.answer RPC call'
      })
      .toBe(true)
    const answerCall = (await getRecordedAskRpcCalls(orcaPage)).find((call) => call.method === 'ask.answer')
    expect(answerCall?.params).toEqual({
      askId,
      answers: { [questionId]: { value: answerText, source: 'input' } },
      skipped: []
    })

    await resolveSeededAsk(orcaPage, { paneKey, askId, summary: 'Answered.' })

    await expect(orcaPage.getByText(question)).toHaveCount(0, { timeout: 10_000 })
    await expect(orcaPage.getByText('Answered.')).toBeVisible()
  })

  test('restores a pending ask with its partial draft intact after a renderer remount', async ({ orcaPage }) => {
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
    await mockAskSnapshotResponse(orcaPage, { asks: [snapshotEvent], seq: 1, epoch: 'e2e-restart-epoch' })

    await replayAskHydration(orcaPage)

    // The regression this guards: a card that merely exists post-restart is not enough — the
    // hydrated draft must reach the field, or the user's in-progress answer is silently lost.
    const field = orcaPage.getByRole('textbox', { name: question })
    await expect(field).toBeVisible({ timeout: 10_000 })
    await expect(field).toHaveValue(draftText)
  })
})
