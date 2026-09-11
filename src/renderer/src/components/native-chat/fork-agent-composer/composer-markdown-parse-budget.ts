export type ComposerMarkdownParseBudget = {
  remaining: number
}

const PARSE_BUDGET_EXCEEDED = Symbol('composer-markdown-parse-budget-exceeded')
const MAX_PARSE_OPERATIONS = 50_000

export function createComposerMarkdownParseBudget(): ComposerMarkdownParseBudget {
  return { remaining: MAX_PARSE_OPERATIONS }
}

export function spendComposerMarkdownParseBudget(budget: ComposerMarkdownParseBudget): void {
  budget.remaining -= 1
  if (budget.remaining < 0) {
    throw PARSE_BUDGET_EXCEEDED
  }
}

export function isComposerMarkdownParseBudgetExceeded(error: unknown): boolean {
  return error === PARSE_BUDGET_EXCEEDED
}
