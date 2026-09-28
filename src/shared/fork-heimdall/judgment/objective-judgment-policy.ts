import type { ObjectiveFailureClass } from '../effect-certainty'
import type { ObjectiveRole } from '../../fork-heimdall-objective/contract-types'
import type { ObjectiveAction } from '../../fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../fork-heimdall-objective/detail-types'
import {
  getActingJudgment,
  OBJECTIVE_JUDGMENT_QUESTION_IDS,
  OBJECTIVE_JUDGMENT_REGISTRY,
  REPORT_QUALITY_REVIEW_SCORE_THRESHOLD,
  VERDICT_QUALITY_REVIEW_SCORE_THRESHOLD,
  type JudgmentQuestionRegistry
} from './registry'

export function objectiveJudgmentHandoffSubject(world: ObjectiveWorld): string | undefined {
  const hosted = world.plan.landing
    .filter((entry) => entry.rung === 'hosted-review')
    .sort((left, right) => right.atMs - left.atMs)[0]
  if (!hosted) {
    return undefined
  }
  return (
    hosted.reviewUrl ??
    (hosted.reviewNumber === undefined
      ? hosted.contentIdentity
      : `${hosted.provider ?? 'hosted'}:${hosted.reviewNumber}`)
  )
}

function authoritativeTaintSubject(
  world: ObjectiveWorld,
  registry: JudgmentQuestionRegistry
): string | undefined {
  if (!world.judgment) {
    return undefined
  }
  for (const recorded of Object.values(world.judgment.answers)) {
    if (recorded.questionId !== OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen) {
      continue
    }
    const answer = getActingJudgment(
      world.judgment,
      recorded.questionId,
      recorded.subjectId,
      registry
    )
    if (answer?.type === 'choice' && answer.choice === 'tainted') {
      return recorded.subjectId
    }
  }
  return undefined
}

export function judgmentFailureClassification(
  world: ObjectiveWorld,
  subjectId: string,
  deterministicClass: ObjectiveFailureClass,
  registry: JudgmentQuestionRegistry = OBJECTIVE_JUDGMENT_REGISTRY
): ObjectiveFailureClass {
  if (deterministicClass !== 'criteria') {
    return deterministicClass
  }
  const answer = getActingJudgment(
    world.judgment,
    OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification,
    subjectId,
    registry
  )
  return answer?.type === 'choice' && (answer.choice === 'infra' || answer.choice === 'environment')
    ? answer.choice
    : deterministicClass
}

export function judgmentRoutedAgent(
  world: ObjectiveWorld,
  roleSubject: string,
  registry: JudgmentQuestionRegistry = OBJECTIVE_JUDGMENT_REGISTRY
): string | undefined {
  const answer = getActingJudgment(
    world.judgment,
    OBJECTIVE_JUDGMENT_QUESTION_IDS.agentRouting,
    roleSubject,
    registry
  )
  return answer?.type === 'choice' ? answer.choice : undefined
}

function qualityNeedsReview(
  world: ObjectiveWorld,
  questionId: string,
  subjectId: string,
  registry: JudgmentQuestionRegistry
): boolean {
  const answer = getActingJudgment(world.judgment, questionId, subjectId, registry)
  const reviewThreshold =
    questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality
      ? REPORT_QUALITY_REVIEW_SCORE_THRESHOLD
      : questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.verdictQuality
        ? VERDICT_QUALITY_REVIEW_SCORE_THRESHOLD
        : undefined
  return reviewThreshold !== undefined && answer?.type === 'score' && answer.score < reviewThreshold
}

export function judgmentQualityReviewSubjects(
  world: ObjectiveWorld,
  registry: JudgmentQuestionRegistry = OBJECTIVE_JUDGMENT_REGISTRY
): string[] {
  if (!world.judgment) {
    return []
  }
  const subjects = new Set<string>()
  for (const recorded of Object.values(world.judgment.answers)) {
    if (
      (recorded.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality ||
        recorded.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.verdictQuality) &&
      qualityNeedsReview(world, recorded.questionId, recorded.subjectId, registry)
    ) {
      subjects.add(recorded.subjectId)
    }
  }
  return [...subjects].sort()
}

export function judgmentPreflightHold(
  world: ObjectiveWorld,
  action: ObjectiveAction,
  registry: JudgmentQuestionRegistry = OBJECTIVE_JUDGMENT_REGISTRY
): string | null {
  if (!world.judgment) {
    return null
  }
  const taintedSubject = authoritativeTaintSubject(world, registry)
  if (taintedSubject !== undefined) {
    return `judgment adversarial pre-screen held worker state ${taintedSubject}`
  }
  const answer = getActingJudgment(
    world.judgment,
    OBJECTIVE_JUDGMENT_QUESTION_IDS.preflight,
    action.capability,
    registry
  )
  return answer?.type === 'choice' && answer.choice === 'hold'
    ? `judgment preflight held ${action.capability}`
    : null
}

export function judgmentHandoffHold(
  world: ObjectiveWorld,
  registry: JudgmentQuestionRegistry = OBJECTIVE_JUDGMENT_REGISTRY
): string | null {
  if (!world.judgment) {
    return null
  }
  const taintedSubject = authoritativeTaintSubject(world, registry)
  if (taintedSubject !== undefined) {
    return `judgment adversarial pre-screen held handoff for worker state ${taintedSubject}`
  }
  const subjectId = objectiveJudgmentHandoffSubject(world)
  if (subjectId === undefined) {
    return null
  }
  const answer = getActingJudgment(
    world.judgment,
    OBJECTIVE_JUDGMENT_QUESTION_IDS.handoff,
    subjectId,
    registry
  )
  return answer?.type === 'choice' && answer.choice === 'hold'
    ? 'judgment held hosted-review handoff derivation'
    : null
}

export function judgmentApprovalAdvisory(
  world: ObjectiveWorld,
  action: ObjectiveAction
): string | null {
  if (!world.judgment) {
    return null
  }
  const recorded = Object.values(world.judgment.answers).find(
    (candidate) =>
      candidate.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.approvalLikelihood &&
      candidate.subjectId === action.capability
  )
  if (!recorded || recorded.answer.type !== 'choice') {
    return null
  }
  const label =
    recorded.answer.choice === 'likely-approve'
      ? 'likely approve'
      : recorded.answer.choice === 'likely-decline'
        ? 'likely decline'
        : recorded.answer.choice === 'unclear'
          ? 'unclear'
          : null
  if (label === null) {
    return null
  }
  const boundedModel = recorded.model.slice(0, 64)
  return `Judgment (${recorded.mode}, ${boundedModel}): ${label}, confidence ${recorded.answer.confidence.toFixed(2)}; advisory only—human approval remains required.`
}

export function objectiveRoutingSubject(role: ObjectiveRole, scope: string): string {
  return `${role}:${scope.length}:${scope}`
}
