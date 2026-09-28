import { z } from 'zod'
import {
  KindAgnosticInterventionSchema,
  OWNER_INTERVENTION_ID_MAX_LENGTH,
  OWNER_INTERVENTION_TEXT_MAX_LENGTH
} from '../fork-heimdall/owner/intervention'
import {
  OBJECTIVE_AGENT_ID_MAX_LENGTH,
  OBJECTIVE_CHECK_COMMAND_MAX_LENGTH,
  OBJECTIVE_CRITERION_BODY_MAX_LENGTH,
  OBJECTIVE_PATH_MAX_LENGTH,
  OBJECTIVE_TASK_KEY_MAX_LENGTH,
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  OBJECTIVE_TASK_TITLE_MAX_LENGTH
} from './contract-types'
import {
  OBJECTIVE_PLAN_MAX_TASKS,
  OBJECTIVE_REPORT_MAX_FILES,
  OBJECTIVE_TASK_MAX_CRITERIA
} from './plan-schema'
import { RevisionAmendmentPatchSchema } from './revision-amendment'

const IdSchema = z.string().trim().min(1).max(OWNER_INTERVENTION_ID_MAX_LENGTH)
const OwnerTextSchema = z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
const AgentSchema = z.string().trim().min(1).max(OBJECTIVE_AGENT_ID_MAX_LENGTH)

/** Excuses a reported-vs-observed file mismatch on a rejected report; never excuses write-territory. */
export const AcceptReportInterventionSchema = z
  .object({
    kind: z.literal('accept-report'),
    dispatchId: IdSchema,
    taskKey: IdSchema,
    attestation: OwnerTextSchema
  })
  .strict()
export type AcceptReportIntervention = z.infer<typeof AcceptReportInterventionSchema>

export const RetryNodeInterventionSchema = z
  .object({
    kind: z.literal('retry-node'),
    taskKey: IdSchema,
    amendedSpec: z.string().trim().min(1).max(OBJECTIVE_TASK_SPEC_MAX_LENGTH).optional(),
    agent: AgentSchema.optional()
  })
  .strict()
export type RetryNodeIntervention = z.infer<typeof RetryNodeInterventionSchema>

export const SkipNodeInterventionSchema = z
  .object({
    kind: z.literal('skip-node'),
    taskKey: IdSchema,
    rationale: OwnerTextSchema
  })
  .strict()
export type SkipNodeIntervention = z.infer<typeof SkipNodeInterventionSchema>

export const AmendPlanInterventionSchema = z
  .object({
    kind: z.literal('amend-plan'),
    revisionId: IdSchema,
    patch: RevisionAmendmentPatchSchema,
    attestation: OwnerTextSchema
  })
  .strict()
export type AmendPlanIntervention = z.infer<typeof AmendPlanInterventionSchema>

export const OwnerDispatchPlannerInterventionSchema = z
  .object({
    kind: z.literal('dispatch-planner'),
    guidance: OwnerTextSchema
  })
  .strict()
export type OwnerDispatchPlannerIntervention = z.infer<
  typeof OwnerDispatchPlannerInterventionSchema
>

/**
 * `stage` is a landing-ladder rung name, or one of the tier-driven stages the landing bar never
 * mandates — `'reviewer'`, `'integrator'`, `'checks'`. A `'checks'` skip names one criterion; the
 * outer `ObjectiveOwnerInterventionSchema` refine enforces that (`criterionId` stays optional here
 * so this schema alone still fits `z.discriminatedUnion`, which cannot take a refined member).
 */
export const SkipStageInterventionSchema = z
  .object({
    kind: z.literal('skip-stage'),
    stage: IdSchema,
    criterionId: IdSchema.optional(),
    rationale: OwnerTextSchema
  })
  .strict()
export type SkipStageIntervention = z.infer<typeof SkipStageInterventionSchema>

export const SetRoleAgentInterventionSchema = z
  .object({
    kind: z.literal('set-role-agent'),
    role: z.enum(['planner', 'implementer', 'reviewer', 'integrator']),
    agent: AgentSchema
  })
  .strict()
export type SetRoleAgentIntervention = z.infer<typeof SetRoleAgentInterventionSchema>

export const ObjectiveSpecificInterventionSchema = z.discriminatedUnion('kind', [
  AcceptReportInterventionSchema,
  RetryNodeInterventionSchema,
  SkipNodeInterventionSchema,
  AmendPlanInterventionSchema,
  OwnerDispatchPlannerInterventionSchema,
  SkipStageInterventionSchema,
  SetRoleAgentInterventionSchema
])
export type ObjectiveSpecificIntervention = z.infer<typeof ObjectiveSpecificInterventionSchema>

/** `OwnerAdapter.interventionSchema` for the objective kind: validates the full vocabulary above. */
export const ObjectiveOwnerInterventionSchema = z
  .discriminatedUnion('kind', [
    ...KindAgnosticInterventionSchema.options,
    ...ObjectiveSpecificInterventionSchema.options
  ])
  .superRefine((intervention, context) => {
    if (
      intervention.kind === 'skip-stage' &&
      intervention.stage === 'checks' &&
      intervention.criterionId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'skip-stage for stage "checks" requires criterionId',
        path: ['criterionId']
      })
    }
  })

/** Appended to `KIND_AGNOSTIC_INTERVENTION_VOCABULARY` in the owner's turn prompt. */
export function describeObjectiveInterventions(): string {
  const codeUnits = (maximum: number): string => `${maximum} JavaScript UTF-16 code units`
  return [
    '{"kind":"accept-report","dispatchId":"...","taskKey":"...","attestation":"..."} — land a' +
      ' rejected report anyway; attestation must state why the mismatch is benign. Never excuses a' +
      ` change outside write territory. dispatchId and taskKey each have max ${codeUnits(OWNER_INTERVENTION_ID_MAX_LENGTH)}; attestation max ${codeUnits(OWNER_INTERVENTION_TEXT_MAX_LENGTH)}.`,
    '{"kind":"retry-node","taskKey":"...","amendedSpec":"...","agent":"..."} — redispatch the' +
      ` task, optionally with a corrected spec or a different agent. taskKey has max ${codeUnits(OWNER_INTERVENTION_ID_MAX_LENGTH)}; amendedSpec max ${codeUnits(OBJECTIVE_TASK_SPEC_MAX_LENGTH)}; agent max ${codeUnits(OBJECTIVE_AGENT_ID_MAX_LENGTH)}.` +
      ' Node history is append-only: the retry must add a new commit, never amend, rebase, squash or' +
      ' reset an existing one — including to fix a commit message.',
    '{"kind":"skip-node","taskKey":"...","rationale":"..."} — drop the task from the plan;' +
      ' refused for a task that already succeeded or is still in flight, permitted once it failed.' +
      ` taskKey has max ${codeUnits(OWNER_INTERVENTION_ID_MAX_LENGTH)}; rationale max ${codeUnits(OWNER_INTERVENTION_TEXT_MAX_LENGTH)}.`,
    '{"kind":"amend-plan","revisionId":"...","patch":{...},"attestation":"..."} — correct the' +
      ' approved revision in place via a RevisionAmendmentPatch.' +
      ` revisionId, patch.digest and each patch.dropTaskKeys entry have max ${codeUnits(OWNER_INTERVENTION_ID_MAX_LENGTH)}; patch.attestation and attestation each max ${codeUnits(OWNER_INTERVENTION_TEXT_MAX_LENGTH)}. patch.upsertTasks and patch.dropTaskKeys each have max ${OBJECTIVE_PLAN_MAX_TASKS} entries.` +
      ` Each upsert task uses taskKey max ${codeUnits(OBJECTIVE_TASK_KEY_MAX_LENGTH)}, title max ${codeUnits(OBJECTIVE_TASK_TITLE_MAX_LENGTH)}, spec max ${codeUnits(OBJECTIVE_TASK_SPEC_MAX_LENGTH)}, deps max ${OBJECTIVE_PLAN_MAX_TASKS}, criteria max ${OBJECTIVE_TASK_MAX_CRITERIA}, criterion body max ${codeUnits(OBJECTIVE_CRITERION_BODY_MAX_LENGTH)}, checkCommand max ${codeUnits(OBJECTIVE_CHECK_COMMAND_MAX_LENGTH)}, and declaredPaths max ${OBJECTIVE_REPORT_MAX_FILES} with each path max ${codeUnits(OBJECTIVE_PATH_MAX_LENGTH)}.`,
    '{"kind":"dispatch-planner","guidance":"..."} — replan now, with guidance for the planner.' +
      ` guidance has max ${codeUnits(OWNER_INTERVENTION_TEXT_MAX_LENGTH)}.`,
    '{"kind":"skip-stage","stage":"reviewer|integrator|checks|<landing rung>","criterionId":"...",' +
      '"rationale":"..."} — skip a stage the landing bar leaves optional: a reviewer or integrator' +
      ' verdict, or one check (criterionId required for "checks"). Refused for any landing rung the' +
      ` bar mandates. stage and criterionId each have max ${codeUnits(OWNER_INTERVENTION_ID_MAX_LENGTH)}; rationale max ${codeUnits(OWNER_INTERVENTION_TEXT_MAX_LENGTH)}.`,
    '{"kind":"set-role-agent","role":"planner|implementer|reviewer|integrator","agent":"..."} —' +
      ` prefer an agent for a role; carried to the next planner dispatch as guidance. agent has max ${codeUnits(OBJECTIVE_AGENT_ID_MAX_LENGTH)}.`
  ].join('\n')
}
