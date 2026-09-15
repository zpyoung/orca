import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult, reportCliError } from '../format'
import { buildCurrentWorktreeSelector } from '../selectors'

type ReviewResult = Record<string, unknown> & {
  exitCode?: unknown
  status?: unknown
  resolved?: unknown
  verdict?: unknown
}

type ReviewCall = {
  method: string
  params: Record<string, unknown>
}

const VERDICT_EXIT_CODES: Record<string, number> = {
  PASS: 0,
  NEEDS_FIXES: 1,
  CRITICAL_ISSUES: 3,
  NOT_REVIEWABLE: 4
}

function optionalParam(
  flags: Map<string, string | boolean>,
  flag: string,
  param = flag
): Record<string, string> {
  const value = getOptionalStringFlag(flags, flag)
  return value === undefined ? {} : { [param]: value }
}

function domainExitCode(command: string, result: ReviewResult): number {
  if (typeof result.exitCode === 'number' && Number.isInteger(result.exitCode)) {
    return result.exitCode
  }
  if (command === 'prepass' && result.status !== 'pass') {
    return 1
  }
  if (command === 'select-model' && result.resolved === false) {
    return 1
  }
  if (command === 'gate' && typeof result.verdict === 'string') {
    return VERDICT_EXIT_CODES[result.verdict] ?? 2
  }
  const negativeField: Record<string, string> = {
    'run-create': 'created',
    'run-abort': 'aborted',
    'run-show': 'found',
    'run-fail': 'failed',
    dismiss: 'dismissed'
  }
  const field = negativeField[command]
  return field && result[field] === false ? 1 : 0
}

async function callReview(
  ctx: HandlerContext,
  command: string,
  buildCall: () => ReviewCall
): Promise<void> {
  try {
    const { method, params } = buildCall()
    const response = await ctx.client.call<ReviewResult>(method, params)
    printResult(response, ctx.json, (result) => JSON.stringify(result))
    process.exitCode = domainExitCode(command, response.result)
  } catch (error) {
    // Why: review reserves exit 2 for mechanical failures instead of the CLI's default exit 1.
    reportCliError(error, true, { commandPath: ['review', command] })
    if (!ctx.json) {
      reportCliError(error, false, { commandPath: ['review', command] })
    }
    process.exitCode = 2
  }
}

function handler(command: string, buildCall: (ctx: HandlerContext) => ReviewCall): CommandHandler {
  return async (ctx) => callReview(ctx, command, () => buildCall(ctx))
}

function worktreeParam(ctx: HandlerContext): { worktree: string } {
  return { worktree: buildCurrentWorktreeSelector(ctx.cwd) }
}

function runParam(ctx: HandlerContext): { worktree: string; run: string } {
  return { ...worktreeParam(ctx), run: getRequiredStringFlag(ctx.flags, 'run') }
}

export const REVIEW_HANDLERS: Record<string, CommandHandler> = {
  'review run-create': handler('run-create', (ctx) => ({
    method: 'review.runCreate',
    params: worktreeParam(ctx)
  })),
  'review resolve': handler('resolve', (ctx) => ({
    method: 'review.resolve',
    params: {
      ...runParam(ctx),
      target: getRequiredStringFlag(ctx.flags, 'target'),
      profile: getRequiredStringFlag(ctx.flags, 'profile'),
      ...optionalParam(ctx.flags, 'criteria-file', 'criteriaFile')
    }
  })),
  'review prepass': handler('prepass', (ctx) => ({
    method: 'review.prepass',
    params: runParam(ctx)
  })),
  'review select-model': handler('select-model', (ctx) => ({
    method: 'review.selectModel',
    params: {
      ...runParam(ctx),
      authorFamily: getRequiredStringFlag(ctx.flags, 'author-family'),
      ...optionalParam(ctx.flags, 'reviewer')
    }
  })),
  'review stage-prompt': handler('stage-prompt', (ctx) => ({
    method: 'review.stagePrompt',
    params: {
      ...runParam(ctx),
      stage: getRequiredStringFlag(ctx.flags, 'stage')
    }
  })),
  'review claims': handler('claims', (ctx) => ({
    method: 'review.claims',
    params: {
      ...runParam(ctx),
      findings: getRequiredStringFlag(ctx.flags, 'findings')
    }
  })),
  'review merge': handler('merge', (ctx) => ({
    method: 'review.merge',
    params: {
      ...runParam(ctx),
      findings: getRequiredStringFlag(ctx.flags, 'findings'),
      judgments: getRequiredStringFlag(ctx.flags, 'judgments'),
      stage: getRequiredStringFlag(ctx.flags, 'stage')
    }
  })),
  'review gate': handler('gate', (ctx) => ({
    method: 'review.gate',
    params: {
      ...runParam(ctx),
      depth: getRequiredStringFlag(ctx.flags, 'depth')
    }
  })),
  'review manifest': handler('manifest', (ctx) => ({
    method: 'review.manifest',
    params: runParam(ctx)
  })),
  'review run-abort': handler('run-abort', (ctx) => ({
    method: 'review.runAbort',
    params: runParam(ctx)
  })),
  'review run-list': handler('run-list', (ctx) => ({
    method: 'review.runList',
    params: worktreeParam(ctx)
  })),
  'review run-show': handler('run-show', (ctx) => ({
    method: 'review.runShow',
    params: runParam(ctx)
  })),
  'review run-fail': handler('run-fail', (ctx) => ({
    method: 'review.runFail',
    params: { ...runParam(ctx), ...optionalParam(ctx.flags, 'reason') }
  })),
  'review dismiss': handler('dismiss', (ctx) => ({
    method: 'review.dismiss',
    params: {
      ...runParam(ctx),
      finding: getRequiredStringFlag(ctx.flags, 'finding'),
      reason: getRequiredStringFlag(ctx.flags, 'reason')
    }
  }))
}
