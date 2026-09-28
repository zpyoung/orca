import { z } from 'zod'

export const EffectCertaintySchema = z.enum(['landed', 'not-landed', 'indeterminate'])
export type EffectCertainty = z.infer<typeof EffectCertaintySchema>

export const WORKER_EXITED_WITHOUT_COMPLETION = 'worker-exited-without-completion'

/** Kind-agnostic; lives beside EffectCertainty rather than in an objective-only module. */
export const ObjectiveFailureClassSchema = z.enum(['infra', 'environment', 'criteria'])
export type ObjectiveFailureClass = z.infer<typeof ObjectiveFailureClassSchema>

export const ReportValidationCodeSchema = z.enum([
  'path-mismatch',
  'missing',
  'oversize',
  'binary',
  'malformed',
  'role-mismatch',
  'task-mismatch',
  'semantic-invalid',
  'evidence-mismatch',
  'evidence-malformed',
  'files-mismatch',
  'workspace-invalid',
  'read-unverifiable'
])
export type ReportValidationCode = z.infer<typeof ReportValidationCodeSchema>

export const ReportValidationProvenanceSchema = z
  .object({
    status: z.enum(['rejected', 'unverifiable']),
    code: ReportValidationCodeSchema,
    sourceCode: z.string().max(1_024).optional(),
    sourceCodeAbbreviated: z.boolean().optional(),
    role: z.enum(['planner', 'implementer', 'reviewer', 'integrator']),
    dispatchId: z.string().trim().min(1).max(1_024),
    taskKey: z.string().trim().min(1).max(1_024).optional(),
    reportPath: z.string().max(8_192).nullable(),
    reportPathAbbreviated: z.boolean().optional(),
    detail: z.string().max(4_096).optional(),
    detailAbbreviated: z.boolean().optional(),
    reportedFiles: z.array(z.string().max(1_024)).max(256),
    reportedFilesOmitted: z.number().int().positive().optional(),
    reportedFilesAbbreviated: z.boolean().optional(),
    observedFiles: z.array(z.string().max(1_024)).max(256),
    observedFilesOmitted: z.number().int().positive().optional(),
    observedFilesAbbreviated: z.boolean().optional(),
    hostVerifiable: z.boolean()
  })
  .strict()
export type ReportValidationProvenance = z.infer<typeof ReportValidationProvenanceSchema>

const DIAGNOSTIC_ABBREVIATION_MARKER = '… [abbreviated]'

function boundedDiagnosticText(
  value: string,
  max: number
): { value: string; abbreviated: boolean } {
  if (value.length <= max) {
    return { value, abbreviated: false }
  }
  return {
    value: `${value.slice(0, max - DIAGNOSTIC_ABBREVIATION_MARKER.length)}${DIAGNOSTIC_ABBREVIATION_MARKER}`,
    abbreviated: true
  }
}

function boundedDiagnosticFiles(files: readonly string[]): {
  values: string[]
  omitted: number
  abbreviated: boolean
} {
  const selected = files.slice(0, 256)
  let abbreviated = files.length > selected.length
  const values = selected.map((file) => {
    const bounded = boundedDiagnosticText(file, 1_024)
    abbreviated ||= bounded.abbreviated
    return bounded.value
  })
  return { values, omitted: files.length - selected.length, abbreviated }
}

export function createReportValidationProvenance(args: {
  status: ReportValidationProvenance['status']
  code: ReportValidationCode
  sourceCode?: string
  role: ReportValidationProvenance['role']
  dispatchId: string
  taskKey?: string
  reportPath: string | null
  detail?: string
  reportedFiles?: readonly string[]
  observedFiles?: readonly string[]
  hostVerifiable: boolean
}): ReportValidationProvenance {
  const reportPath = args.reportPath === null ? null : boundedDiagnosticText(args.reportPath, 8_192)
  const sourceCode =
    args.sourceCode === undefined ? undefined : boundedDiagnosticText(args.sourceCode, 1_024)
  const detail = args.detail === undefined ? undefined : boundedDiagnosticText(args.detail, 4_096)
  const reported = boundedDiagnosticFiles(args.reportedFiles ?? [])
  const observed = boundedDiagnosticFiles(args.observedFiles ?? [])
  const dispatchId = boundedDiagnosticText(args.dispatchId, 1_024)
  const taskKey =
    args.taskKey === undefined ? undefined : boundedDiagnosticText(args.taskKey, 1_024)
  return {
    status: args.status,
    code: args.code,
    ...(sourceCode === undefined ? {} : { sourceCode: sourceCode.value }),
    ...(sourceCode?.abbreviated ? { sourceCodeAbbreviated: true } : {}),
    role: args.role,
    dispatchId: dispatchId.value,
    ...(taskKey === undefined ? {} : { taskKey: taskKey.value }),
    reportPath: reportPath === null ? null : reportPath.value,
    ...(reportPath?.abbreviated ? { reportPathAbbreviated: true } : {}),
    ...(detail === undefined ? {} : { detail: detail.value }),
    ...(detail?.abbreviated ? { detailAbbreviated: true } : {}),
    reportedFiles: reported.values,
    ...(reported.omitted > 0 ? { reportedFilesOmitted: reported.omitted } : {}),
    ...(reported.abbreviated ? { reportedFilesAbbreviated: true } : {}),
    observedFiles: observed.values,
    ...(observed.omitted > 0 ? { observedFilesOmitted: observed.omitted } : {}),
    ...(observed.abbreviated ? { observedFilesAbbreviated: true } : {}),
    hostVerifiable: args.hostVerifiable
  }
}

export const ActionOutcomeSchema = z
  .object({
    effect: EffectCertaintySchema,
    result: z.unknown().optional(),
    expectedBefore: z.string().optional(),
    expectedAfter: z.string().optional(),
    reason: z.string().optional(),
    failureClass: ObjectiveFailureClassSchema.optional()
  })
  .strict()

export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>

/** Widens resolveOutcome beyond a bare EffectCertainty so async recovery can also classify why. */
export type EffectCertaintyResolution = {
  effect: EffectCertainty
  failureClass?: ObjectiveFailureClass
  reportValidation?: ReportValidationProvenance
}

/** Resolves an effect only when the authority shows one of the two expected states. */
export function resolveByExpectedState(
  observed: string,
  expectedBefore: string,
  expectedAfter: string
): EffectCertainty {
  if (observed === expectedAfter) {
    return 'landed'
  }
  if (observed === expectedBefore) {
    return 'not-landed'
  }
  return 'indeterminate'
}
