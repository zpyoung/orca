import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type {
  HandoffDerivation,
  KernelAction,
  StopPredicate,
  WatcherKind
} from '../../shared/fork-heimdall/kind-contract'
import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { builtinOneNodeRunState } from '../../shared/fork-heimdall-pipeline/interpreter/run-state'
import {
  action as makeAction,
  authorized,
  enrollmentInput,
  harness,
  kind,
  type World
} from '../fork-heimdall/kernel-service-test-harness'
import {
  registerBuiltinPipelineKind,
  type BuiltinPipelinePresentation
} from './builtin-one-node-kind'

vi.mock('electron', () => ({}))

const objectivePayload: ObjectiveEnrollmentPayload = {
  objectiveText: 'Implement the objective safely.',
  tier: 'standard',
  landingBar: 'hosted-review',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: { planner: 'codex' },
  sitterOverrides: {}
}

function objectiveInput(kindPayload: ObjectiveEnrollmentPayload): EnrollInput {
  return {
    ...enrollmentInput(),
    kind: 'objective',
    capabilities: {
      plan: 'on',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'on'
    },
    kindPayload
  }
}

function objectiveKind(
  overrides: Partial<WatcherKind<World, KernelAction, ObjectiveEnrollmentPayload>> = {}
): WatcherKind<World, KernelAction, ObjectiveEnrollmentPayload> {
  return {
    ...kind({ id: 'objective' }),
    enrollmentPayloadSchema: ObjectiveEnrollmentPayloadSchema,
    ...overrides
  }
}

function presentationOf<TEnrollmentPayload>(
  registered: WatcherKind<World, KernelAction, TEnrollmentPayload>
): BuiltinPipelinePresentation<World> {
  const value: unknown = Object.getOwnPropertyDescriptor(registered, 'pipelinePresentation')?.value
  if (
    value === null ||
    typeof value !== 'object' ||
    !('pin' in value) ||
    !('phase' in value) ||
    typeof value.phase !== 'function'
  ) {
    throw new Error('Expected a built-in pipeline presentation')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerBuiltinPipelineKind creates this presentation with the declared pin and phase contract; the runtime guard confirms the property and callable phase survived registration.
  return value as BuiltinPipelinePresentation<World>
}

describe('registerBuiltinPipelineKind', () => {
  it('exposes built-in action identity and pipeline presentation state', () => {
    const innerAction = {
      ...makeAction('revision-1'),
      kind: 'update-branch',
      capability: 'updateBranch'
    }
    const inner = objectiveKind({
      describeSnapshot: () => ({ phase: 'implementation' }),
      decide: () => ({ action: innerAction })
    })
    let registered: WatcherKind<World, KernelAction, ObjectiveEnrollmentPayload> | undefined
    const registerKind = (
      candidate: WatcherKind<World, KernelAction, ObjectiveEnrollmentPayload>
    ) => {
      registered = candidate
    }
    registerBuiltinPipelineKind({ registerKind }, 'objective', inner)
    if (registered === undefined) {
      throw new Error('Expected the objective kind to register')
    }

    const current = {
      freshness: 'live' as const,
      contentIdentity: 'revision-1',
      observedAtMs: 1,
      world: { revision: 'revision-1' }
    }
    const currentLedger = { watcherId: 'watcher-1', entries: [] }
    const outcome = registered.decide(current, currentLedger)
    if (outcome.action === null) {
      throw new Error('Expected the built-in action to pass through')
    }
    expect(
      makeAttemptFingerprint(
        outcome.action.contentIdentity,
        outcome.action.kind,
        outcome.action.evidenceKey
      )
    ).toBe(makeAttemptFingerprint('revision-1', 'update-branch', 'review:revision-1'))
    const presentation = presentationOf(registered)
    expect(presentation.pin).toMatchObject({
      ref: 'builtin:objective',
      scope: 'builtin',
      id: 'objective'
    })
    expect(presentation.phase(current, currentLedger)).toBe('running-tasks')
    expect(
      builtinOneNodeRunState('objective', 'running-tasks').nodes.get('objective')
    ).toMatchObject({
      status: 'running',
      phase: 'running-tasks'
    })
    const terminal = builtinOneNodeRunState('objective', 'landed', { done: 3, total: 3 }, 4)
    expect(terminal.terminal).toBe('complete')
    expect(terminal.nodes.get('objective')).toMatchObject({
      status: 'done',
      phase: 'landed',
      progress: { done: 3, total: 3 },
      revision: 4
    })
  })
  it('pins the hosted-review kind as the built-in PR-sitter graph', () => {
    const inner = kind()
    let registered: WatcherKind<World, KernelAction, { label: string }> | undefined
    const registerKind = (candidate: WatcherKind<World, KernelAction, { label: string }>) => {
      registered = candidate
    }

    registerBuiltinPipelineKind({ registerKind }, 'hosted-review', inner)

    if (registered === undefined) {
      throw new Error('Expected the hosted-review kind to register')
    }
    expect(presentationOf(registered).pin).toMatchObject({
      ref: 'builtin:pr-sitter',
      scope: 'builtin',
      id: 'pr-sitter'
    })
    expect(
      presentationOf(registered).phase(
        {
          freshness: 'live',
          contentIdentity: 'review-head',
          observedAtMs: 1,
          world: { revision: 'review-head' }
        },
        { watcherId: 'watcher-1', entries: [] }
      )
    ).toBe('watching')
  })

  it('transfers a terminal Objective run into a hosted-review watcher', async () => {
    const world = await harness()
    const sitterInput: EnrollInput = {
      ...enrollmentInput(),
      kindPayload: { label: 'Sitter', reviewUrl: 'https://example.test/review/1' }
    }
    const derivation: HandoffDerivation = {
      kind: 'enroll',
      input: sitterInput,
      reason: 'bar-reached'
    }
    const derive = async () => derivation
    const stopPredicate = {
      id: 'objective-bar-reached',
      disposition: 'terminal',
      evaluate: () => ({ stop: true as const, reason: 'bar-reached' })
    } satisfies StopPredicate<World>
    const inner = objectiveKind({
      handoff: { derive },
      stopPredicates: [stopPredicate]
    })
    const sitterKind = {
      ...kind(),
      authorizeEnrollment: async (input) => authorized(input),
      enrollmentPayloadSchema: z.object({ label: z.string(), reviewUrl: z.string().url() }).strict()
    } satisfies WatcherKind<World, KernelAction, { label: string; reviewUrl: string }>

    world.service.registerKind(sitterKind)
    registerBuiltinPipelineKind(world.service, 'objective', inner)
    const enrollment = await world.service.enroll(objectiveInput(objectivePayload))
    if (enrollment.status !== 'enrolled') {
      throw new Error('Expected the Objective watcher to enroll')
    }

    await world.service.reconcileForTesting(enrollment.entry.enrollment.watcherId)

    expect(world.enrollmentStore.list()).toHaveLength(2)
    expect(world.enrollmentStore.get(enrollment.entry.enrollment.watcherId)).toMatchObject({
      enabled: false,
      terminalAtMs: 100
    })
    expect(world.service.ledger(enrollment.entry.enrollment.watcherId).entries).toEqual([
      expect.objectContaining({ kind: 'terminal' })
    ])
    const sitter = world.enrollmentStore.list().find((record) => record.kind === 'hosted-review')
    expect(sitter).toMatchObject({ kindPayload: sitterInput.kindPayload, enabled: true })
    await world.service.stopForShutdown()
  })
})
