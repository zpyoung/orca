import type { JudgmentAnswer, JudgmentRecordedAnswer, JudgmentSnapshot } from './types'

export const JUDGMENT_BASELINE_MODEL = 'jev-1.13'
export const JUDGMENT_PUBLISHED_UNCERTAIN_CONFIDENCE = 0.5
export const JUDGMENT_PUBLISHED_HIGH_CONFIDENCE = 0.9

export const OBJECTIVE_JUDGMENT_QUESTION_IDS = {
  adversarialPrescreen: 'objective.adversarial-prescreen',
  failureClassification: 'objective.failure-classification',
  agentRouting: 'objective.agent-routing',
  escalationTaskScope: 'objective.escalation-task-scope',
  escalationAuthority: 'objective.escalation-authority',
  reportQuality: 'objective.report-quality',
  verdictQuality: 'objective.verdict-quality',
  preflight: 'objective.preflight',
  handoff: 'objective.handoff',
  approvalLikelihood: 'objective.approval-likelihood'
} as const

/** Kernel-level questions that belong to no watcher kind. */
export const HEIMDALL_JUDGMENT_QUESTION_IDS = {
  stallCause: 'heimdall.stall-cause'
} as const

export const STALL_CAUSE_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const ADVERSARIAL_PRESCREEN_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const FAILURE_CLASSIFICATION_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const AGENT_ROUTING_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const ESCALATION_TASK_SCOPE_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const ESCALATION_AUTHORITY_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const REPORT_QUALITY_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_UNCERTAIN_CONFIDENCE
export const VERDICT_QUALITY_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_UNCERTAIN_CONFIDENCE
export const REPORT_QUALITY_REVIEW_SCORE_THRESHOLD = 2
export const VERDICT_QUALITY_REVIEW_SCORE_THRESHOLD = 2
export const PREFLIGHT_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const HANDOFF_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_HIGH_CONFIDENCE
export const APPROVAL_LIKELIHOOD_CONFIDENCE_THRESHOLD = JUDGMENT_PUBLISHED_UNCERTAIN_CONFIDENCE

export type JudgmentQuestionMode = 'shadow' | 'acting'
type JudgmentConfidenceRule = 'at-least' | 'greater-than'
type JudgmentAnswerType = JudgmentAnswer['type']

export type JudgmentQuestionPolicy = {
  mode: JudgmentQuestionMode
  thresholdName: string
  calibratedModel: string | null
}

export type JudgmentRegistryEntry = JudgmentQuestionPolicy & {
  answerType: JudgmentAnswerType
  confidenceThreshold: number
  confidenceRule: JudgmentConfidenceRule
}

export type JudgmentQuestionRegistry = Readonly<Record<string, JudgmentRegistryEntry>>

export const OBJECTIVE_JUDGMENT_REGISTRY: JudgmentQuestionRegistry = {
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen]: {
    mode: 'shadow',
    thresholdName: 'adversarial-prescreen-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: ADVERSARIAL_PRESCREEN_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification]: {
    mode: 'shadow',
    thresholdName: 'failure-classification-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: FAILURE_CLASSIFICATION_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.agentRouting]: {
    mode: 'shadow',
    thresholdName: 'agent-routing-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: AGENT_ROUTING_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.escalationTaskScope]: {
    mode: 'shadow',
    thresholdName: 'escalation-task-scope-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: ESCALATION_TASK_SCOPE_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.escalationAuthority]: {
    mode: 'shadow',
    thresholdName: 'escalation-authority-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: ESCALATION_AUTHORITY_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality]: {
    mode: 'shadow',
    thresholdName: 'report-quality-uncertain-confidence',
    calibratedModel: null,
    answerType: 'score',
    confidenceThreshold: REPORT_QUALITY_CONFIDENCE_THRESHOLD,
    confidenceRule: 'at-least'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.verdictQuality]: {
    mode: 'shadow',
    thresholdName: 'verdict-quality-uncertain-confidence',
    calibratedModel: null,
    answerType: 'score',
    confidenceThreshold: VERDICT_QUALITY_CONFIDENCE_THRESHOLD,
    confidenceRule: 'at-least'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.preflight]: {
    mode: 'shadow',
    thresholdName: 'preflight-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: PREFLIGHT_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.handoff]: {
    mode: 'shadow',
    thresholdName: 'handoff-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: HANDOFF_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  },
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.approvalLikelihood]: {
    mode: 'shadow',
    thresholdName: 'approval-likelihood-uncertain-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: APPROVAL_LIKELIHOOD_CONFIDENCE_THRESHOLD,
    confidenceRule: 'at-least'
  }
}

/** Shadow-only: nothing reads a stall-cause answer, and it is not in the acting gate's registry. */
export const HEIMDALL_JUDGMENT_REGISTRY: JudgmentQuestionRegistry = {
  [HEIMDALL_JUDGMENT_QUESTION_IDS.stallCause]: {
    mode: 'shadow',
    thresholdName: 'stall-cause-high-confidence',
    calibratedModel: null,
    answerType: 'choice',
    confidenceThreshold: STALL_CAUSE_CONFIDENCE_THRESHOLD,
    confidenceRule: 'greater-than'
  }
}

export function getJudgmentQuestionPolicy(questionId: string): JudgmentQuestionPolicy | null {
  const entry = OBJECTIVE_JUDGMENT_REGISTRY[questionId] ?? HEIMDALL_JUDGMENT_REGISTRY[questionId]
  if (!entry) {
    return null
  }
  return {
    mode: entry.mode,
    thresholdName: entry.thresholdName,
    calibratedModel: entry.calibratedModel
  }
}

function recordedAnswer(
  snapshot: JudgmentSnapshot,
  questionId: string,
  subjectId: string
): JudgmentRecordedAnswer | undefined {
  return Object.values(snapshot.answers).find(
    (candidate) => candidate.questionId === questionId && candidate.subjectId === subjectId
  )
}

function meetsConfidence(answer: JudgmentAnswer, policy: JudgmentRegistryEntry): boolean {
  if (answer.type === 'noul') {
    return false
  }
  return policy.confidenceRule === 'greater-than'
    ? answer.confidence > policy.confidenceThreshold
    : answer.confidence >= policy.confidenceThreshold
}

function authoritativeRecordedAnswer(
  snapshot: JudgmentSnapshot,
  questionId: string,
  subjectId: string,
  registry: JudgmentQuestionRegistry
): JudgmentRecordedAnswer | undefined {
  if (snapshot.status !== 'answered') {
    return undefined
  }
  const policy = registry[questionId]
  if (!policy || policy.mode !== 'acting' || policy.calibratedModel === null) {
    return undefined
  }
  const recorded = recordedAnswer(snapshot, questionId, subjectId)
  if (
    !recorded ||
    recorded.mode !== 'acting' ||
    recorded.model !== policy.calibratedModel ||
    recorded.answer.type !== policy.answerType ||
    !meetsConfidence(recorded.answer, policy)
  ) {
    return undefined
  }
  return recorded
}

function workerStateScreensPermitAuthority(
  snapshot: JudgmentSnapshot,
  registry: JudgmentQuestionRegistry
): boolean {
  let sawScreen = false
  const questionId = OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen
  for (const candidate of Object.values(snapshot.answers)) {
    if (candidate.questionId !== questionId) {
      continue
    }
    sawScreen = true
    const authoritative = authoritativeRecordedAnswer(
      snapshot,
      questionId,
      candidate.subjectId,
      registry
    )
    if (authoritative?.answer.type !== 'choice' || authoritative.answer.choice !== 'clean') {
      return false
    }
  }
  return sawScreen
}

/**
 * The sole authority gate for judgment consumers. The injectable registry is for focused policy
 * boundary tests; production callers omit it and therefore use commit-pinned constants.
 */
export function getActingJudgment(
  snapshot: JudgmentSnapshot | undefined,
  questionId: string,
  subjectId: string,
  registry: JudgmentQuestionRegistry = OBJECTIVE_JUDGMENT_REGISTRY
): JudgmentAnswer | undefined {
  if (!snapshot) {
    return undefined
  }
  if (
    questionId !== OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen &&
    !workerStateScreensPermitAuthority(snapshot, registry)
  ) {
    return undefined
  }
  return authoritativeRecordedAnswer(snapshot, questionId, subjectId, registry)?.answer
}
