import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  composeHandoffBrief,
  type HandoffBriefInputs
} from '@/lib/fork-session-handoff/handoff-brief-composer'
import type { HandoffTargetResolution } from '@/lib/fork-session-handoff/handoff-target-resolution'

const mocks = vi.hoisted(() => ({
  locale: 'en',
  state: {} as Record<string, unknown>,
  getHandoffAnchorRepoId: vi.fn(),
  resolveHandoffTarget: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => `${mocks.locale}:${fallback}`,
  i18n: {
    get language() {
      return mocks.locale
    }
  }
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/lib/fork-session-handoff/handoff-target-resolution', () => ({
  getHandoffAnchorRepoId: mocks.getHandoffAnchorRepoId,
  resolveHandoffTarget: mocks.resolveHandoffTarget
}))
import type { HandoffPreviewPhase } from '@/lib/fork-session-handoff/handoff-preview-detach'
import {
  buildHandoffWarnings,
  createAndSelectInlineHandoffTarget,
  getHandoffContextDisabledReason,
  getHandoffTemplates,
  handoffInlinedCapture,
  isHandoffContextEmpty,
  isHandoffStartDisabled,
  persistHandoffPreferencesBestEffort,
  resolveHandoffBodyForStart,
  visibleHandoffCompositionWarnings
} from './handoff-dialog-model'

function target(worktreeId = 'wt-target'): HandoffTargetResolution {
  return {
    worktreeId,
    workspacePath: '/target',
    initialCwd: '/target',
    sshConnectionId: null,
    runtimeEnvironmentId: null,
    isFolderWorkspace: false
  }
}

const emptyInputs: HandoffBriefInputs = {
  source: {
    sourceAgent: 'codex',
    capturedText: '',
    sourceTitle: 'Source'
  },
  contextMode: 'focused',
  transcriptUsableOnTarget: false,
  inlinedCapture: null,
  repoState: null,
  openEditorTabs: null,
  template: null,
  steeringNote: '',
  externalContextBlock: null
}

describe('handoff dialog model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.locale = 'en'
    mocks.state = {}
  })

  it('seeds named templates when settings has none', () => {
    expect(getHandoffTemplates(undefined).map((template) => template.id)).toEqual([
      'continue-implementation',
      'review-completed-work',
      'debug-failure'
    ])
  })

  it('resolves default template labels in the active locale without replacing custom templates', () => {
    expect(getHandoffTemplates(undefined)[0]?.name).toBe('en:Continue implementation')

    mocks.locale = 'es'
    expect(getHandoffTemplates(undefined)[0]?.name).toBe('es:Continue implementation')
    expect(getHandoffTemplates([])).toEqual([])
    expect(getHandoffTemplates([{ id: 'custom', name: 'Operator label', body: 'Body' }])).toEqual([
      { id: 'custom', name: 'Operator label', body: 'Body' }
    ])
  })

  it('falls back for malformed catalogs and drops malformed rows from arrays', () => {
    expect(getHandoffTemplates({ invalid: true } as never)).toHaveLength(3)
    expect(
      getHandoffTemplates([
        { id: 'valid', name: ' Name ', body: ' Body ' },
        { id: 'blank', name: '', body: 'Missing name' }
      ])
    ).toEqual([{ id: 'valid', name: 'Name', body: 'Body' }])
  })

  it('keeps host and secret warnings additive', () => {
    const hit = {
      ruleId: 'github-token',
      line: 1,
      start: 0,
      end: 4,
      redactedExcerpt: 'ghp_…'
    }
    const warnings = buildHandoffWarnings({
      sourceBusy: false,
      hostChanged: true,
      secretHits: [hit],
      transcriptReachability: 'usable',
      compositionWarnings: [],
      previewPhase: { phase: 'attached' },
      operationErrors: []
    })

    expect(warnings).toEqual([{ kind: 'host-changed' }, { kind: 'secret-hits', hits: [hit] }])
  })

  // F1: an undecided probe and an absent transcript get different wording, so
  // the dialog must not fold "could not verify" into "not on this target".
  it.each([
    ['unreachable', 'transcript-unreachable'],
    ['unverifiable', 'transcript-unverifiable']
  ] as const)('warns distinctly for a %s transcript', (reachability, kind) => {
    expect(
      buildHandoffWarnings({
        sourceBusy: false,
        hostChanged: false,
        secretHits: [],
        transcriptReachability: reachability,
        compositionWarnings: [],
        previewPhase: { phase: 'attached' },
        operationErrors: []
      })
    ).toEqual([{ kind }])
    expect(getHandoffContextDisabledReason(reachability)).toBeTruthy()
  })

  it('separates the disabled-context wording for the two failure verdicts', () => {
    expect(getHandoffContextDisabledReason('usable')).toBeNull()
    expect(getHandoffContextDisabledReason('unverifiable')).not.toBe(
      getHandoffContextDisabledReason('unreachable')
    )
  })

  it('inlines the bounded capture whenever the transcript will not travel', () => {
    expect(handoffInlinedCapture('unreachable', 'capture')).toBe('capture')
    expect(handoffInlinedCapture('unverifiable', 'capture')).toBe('capture')
    expect(handoffInlinedCapture('usable', 'capture')).toBeNull()
    expect(handoffInlinedCapture('none', 'capture')).toBeNull()
  })

  it('lets a nonempty detached preview supply otherwise missing context', () => {
    const previewPhase: HandoffPreviewPhase = { phase: 'detached', staleReasons: [] }

    expect(
      isHandoffContextEmpty({
        compositionWarnings: ['no-context'],
        previewPhase,
        editedBody: 'Operator-authored handoff'
      })
    ).toBe(false)
    expect(
      visibleHandoffCompositionWarnings({
        compositionWarnings: ['no-transcript-context', 'no-context'],
        previewPhase,
        editedBody: 'Operator-authored handoff'
      })
    ).toEqual(['no-transcript-context'])
    expect(
      resolveHandoffBodyForStart({
        inputs: emptyInputs,
        previewPhase,
        editedBody: 'Operator-authored handoff',
        previewedBody: 'Operator-authored handoff',
        latestCapture: 'new capture'
      })
    ).toEqual({ status: 'ready', body: 'Operator-authored handoff' })
  })

  it('requires a second unchanged Start after an attached live capture changes', () => {
    const oldInputs: HandoffBriefInputs = {
      ...emptyInputs,
      source: { ...emptyInputs.source, capturedText: 'old capture' },
      inlinedCapture: 'old capture'
    }
    const previewedBody = composeHandoffBrief(oldInputs).editableBody
    const checkpoint = resolveHandoffBodyForStart({
      inputs: oldInputs,
      previewPhase: { phase: 'attached' },
      editedBody: '',
      previewedBody,
      latestCapture: 'new capture'
    })

    expect(checkpoint.status).toBe('capture-changed')
    expect(checkpoint.body).toContain('new capture')

    const newInputs: HandoffBriefInputs = {
      ...oldInputs,
      source: { ...oldInputs.source, capturedText: 'new capture' },
      inlinedCapture: 'new capture'
    }
    expect(
      resolveHandoffBodyForStart({
        inputs: newInputs,
        previewPhase: { phase: 'attached' },
        editedBody: '',
        previewedBody: checkpoint.body,
        latestCapture: 'new capture'
      })
    ).toEqual({ status: 'ready', body: checkpoint.body })
  })

  it('disables Start while transcript reachability is being checked', () => {
    expect(
      isHandoffStartDisabled({
        starting: false,
        detectingAgents: false,
        selectedAgent: 'codex',
        target: target(),
        noContext: false,
        transcriptReachabilityLoading: true,
        repoStateLoading: false,
        repoStateIncluded: true,
        createMode: false,
        createName: ''
      })
    ).toBe(true)
  })

  it('selects a created id before resolving its launch target', async () => {
    const createWorktree = vi.fn().mockResolvedValue({ worktree: { id: 'wt-created' } })
    const onCreated = vi.fn()
    mocks.state = { createWorktree }
    mocks.getHandoffAnchorRepoId.mockReturnValue('repo-1')
    mocks.resolveHandoffTarget.mockReturnValue(null)

    await expect(
      createAndSelectInlineHandoffTarget({
        anchorWorktreeId: 'wt-anchor',
        name: 'new-worktree',
        baseBranch: '',
        launchSource: 'sidebar',
        onCreated
      })
    ).rejects.toThrow('en:The new worktree could not be resolved.')
    expect(onCreated).toHaveBeenCalledWith('wt-created')
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('absorbs a rejected preference write after launch success', async () => {
    const update = vi.fn().mockRejectedValue(new Error('settings offline'))

    await expect(
      persistHandoffPreferencesBestEffort({
        update,
        settings: { lastAgent: 'codex' }
      })
    ).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith({
      forkSessionHandoff: { lastAgent: 'codex' }
    })
  })
})
