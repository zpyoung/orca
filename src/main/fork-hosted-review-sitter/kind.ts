import type { WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  actionWritesWorktree,
  decideHostedReview,
  describeHostedReviewSnapshot,
  hostedReviewContentIdentity,
  hostedReviewPreflight,
  HOSTED_REVIEW_STOP_PREDICATES,
  paceHostedReview,
  type HostedReviewEnrollmentPayload,
  type HostedReviewSitterAction,
  type HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readHostedReviewPreparedCommit } from './agent-execution'
import { inspectHostedReviewSitterContention } from './contention'
import {
  authorizeHostedReviewSitterDefinition,
  hostedReviewDefinitionFromEnrollment
} from './definition'
import { enrollmentPayloadSchema, parseHostedReviewEnrollmentPayload } from './definition-store'
import { createHostedReviewSitterProvider, resolveHostedReviewSitterGitExecution } from './provider'
import {
  executeHostedReviewSitterAction,
  resolveHostedReviewSitterOutcome
} from './service-action-executor'

export type HostedReviewKind = WatcherKind<
  HostedReviewWorld,
  HostedReviewSitterAction,
  HostedReviewEnrollmentPayload
>

export type HostedReviewKernelRegistration = {
  registerKind(kind: HostedReviewKind): void
}

export function createHostedReviewKind(
  runtime: OrcaRuntimeService,
  store: Store
): HostedReviewKind {
  const provider = createHostedReviewSitterProvider(runtime, store)
  return {
    id: 'hosted-review',
    displayName: 'Hosted review',
    enrollmentPayloadSchema,
    authorizeEnrollment: (input) => authorizeHostedReviewSitterDefinition(runtime, store, input),
    describeEnrollment(enrollment) {
      const payload = parseHostedReviewEnrollmentPayload(enrollment.kindPayload)
      return payload
        ? `${payload.provider === 'github' ? 'Pull request' : 'Merge request'} #${payload.reviewNumber}`
        : `Hosted review in ${enrollment.workspacePath}`
    },
    async read(enrollment: WatcherEnrollment, options): Promise<Snapshot<HostedReviewWorld>> {
      const definition = hostedReviewDefinitionFromEnrollment(enrollment)
      const review = await provider.read(definition, options)
      if (
        review.provider !== definition.provider ||
        review.reviewNumber !== definition.reviewNumber ||
        review.url !== definition.reviewUrl
      ) {
        throw new Error('Hosted review provider identity changed')
      }
      const git = await resolveHostedReviewSitterGitExecution(runtime, store, definition)
      const preparedCommit = await readHostedReviewPreparedCommit(git, review.headSha)
      return {
        freshness: options.fresh ? 'live' : 'cached',
        contentIdentity: hostedReviewContentIdentity(review),
        observedAtMs: Date.now(),
        world: { review, definition, preparedCommit }
      }
    },
    describeSnapshot(snapshot) {
      return { ...describeHostedReviewSnapshot(snapshot) }
    },
    decide: decideHostedReview,
    async preflight(action, snapshot) {
      const contention = actionWritesWorktree(action, snapshot.world.definition)
        ? await inspectHostedReviewSitterContention(runtime, store, snapshot.world.definition)
        : { state: 'clear' as const }
      return hostedReviewPreflight(action, snapshot, contention)
    },
    execute: (action, context) =>
      executeHostedReviewSitterAction(runtime, store, provider, action, context),
    resolveOutcome: resolveHostedReviewSitterOutcome,
    stopPredicates: HOSTED_REVIEW_STOP_PREDICATES,
    pacing: { pace: paceHostedReview }
  }
}

export function registerHostedReviewKind(
  kernel: HostedReviewKernelRegistration,
  runtime: OrcaRuntimeService,
  store: Store
): void {
  kernel.registerKind(createHostedReviewKind(runtime, store))
}
