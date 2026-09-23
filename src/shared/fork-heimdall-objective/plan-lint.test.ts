import { describe, expect, it } from 'vitest'
import { lintObjectivePlan, type LintObjectivePlanInput, type PlanLintCode } from './plan-lint'
import type { ObjectivePlanAssumption, ObjectivePlanTask } from './plan-schema'

function task(taskKey: string, overrides: Partial<ObjectivePlanTask> = {}): ObjectivePlanTask {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec: `Implement ${taskKey}`,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    ...overrides
  }
}

function lint(
  overrides: Partial<LintObjectivePlanInput> & { plan: ObjectivePlanTask[] }
): ReturnType<typeof lintObjectivePlan> {
  return lintObjectivePlan({
    assumptions: [],
    writeTerritory: ['**'],
    gates: [],
    ...overrides
  })
}

function codesFor(
  result: ReturnType<typeof lintObjectivePlan>,
  taskKey: string | null
): PlanLintCode[] {
  return result.findings
    .filter((finding) => finding.taskKey === taskKey)
    .map((finding) => finding.code)
}

describe('lintObjectivePlan territory findings', () => {
  it('flags a task with no declared territory and skips it for conflict pairs', () => {
    const result = lint({
      plan: [task('a'), task('b', { territory: ['src/**'] })]
    })
    expect(codesFor(result, 'a')).toContain('missing-territory')
    expect(result.conflictPairs).toEqual([])
  })

  it('flags territory reaching outside the objective write territory', () => {
    const outside = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['docs/**'] })]
    })
    expect(codesFor(outside, 'a')).toContain('territory-outside-objective')

    const inside = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a/**'] })]
    })
    expect(codesFor(inside, 'a')).not.toContain('territory-outside-objective')
  })

  it('flags territory that only ever touches test files', () => {
    const testOnly = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a/**/*.test.ts'] })]
    })
    expect(codesFor(testOnly, 'a')).toContain('test-only-node')

    const mixed = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a/b.ts', 'src/a/b.test.ts'] })]
    })
    expect(codesFor(mixed, 'a')).not.toContain('test-only-node')
  })

  it('flags a concrete test-file territory, not just a wildcard glob', () => {
    const literalFile = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a.test.ts'] })]
    })
    expect(codesFor(literalFile, 'a')).toContain('test-only-node')

    const wildcardStem = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a/foo*.spec.tsx'] })]
    })
    expect(codesFor(wildcardStem, 'a')).toContain('test-only-node')

    const mixed = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a.test.ts', 'src/b.ts'] })]
    })
    expect(codesFor(mixed, 'a')).not.toContain('test-only-node')
  })
})

describe('lintObjectivePlan check-command findings', () => {
  function withCommand(command: string, extra: Partial<ObjectivePlanTask> = {}) {
    return lint({
      plan: [
        task('a', {
          criteria: [{ body: 'checked', shellCheckable: true, checkCommand: command }],
          ...extra
        })
      ]
    })
  }

  it('flags full-suite commands', () => {
    expect(codesFor(withCommand('pnpm test'), 'a')).toContain('full-suite-check')
    expect(codesFor(withCommand('pnpm test:sandbox --shards=16'), 'a')).toContain(
      'full-suite-check'
    )
    expect(
      codesFor(withCommand('pnpm test:sandbox --shards=1 --only=1 -- src/a/b.test.ts'), 'a')
    ).not.toContain('full-suite-check')
    expect(codesFor(withCommand('pnpm typecheck'), 'a')).toContain('full-suite-check')
  })

  it('flags a full-suite command mentioned in the task spec', () => {
    const result = lint({
      plan: [task('a', { spec: 'Implement the change, then run pnpm lint before returning.' })]
    })
    expect(codesFor(result, 'a')).toContain('full-suite-check')
  })

  it('flags an unscoped test invocation and accepts a path-scoped one', () => {
    expect(codesFor(withCommand('vitest run'), 'a')).toContain('unscoped-check')
    expect(codesFor(withCommand('vitest run src/a.test.ts'), 'a')).not.toContain('unscoped-check')
  })

  it('accepts a filename-only scope with no path separator (C2)', () => {
    expect(codesFor(withCommand('vitest run a.test.ts'), 'a')).not.toContain('unscoped-check')
    expect(codesFor(withCommand('tsc -p tsconfig.json'), 'a')).not.toContain('unscoped-check')
  })

  it('still flags a bare invocation with no scope argument at all (C2)', () => {
    expect(codesFor(withCommand('vitest run'), 'a')).toContain('unscoped-check')
    expect(codesFor(withCommand('pnpm test'), 'a')).toContain('unscoped-check')
  })

  it('judges each shell-chained segment for an unscoped invocation independently', () => {
    expect(codesFor(withCommand('echo src/foo && vitest run'), 'a')).toContain('unscoped-check')
    expect(codesFor(withCommand('vitest run src/a.test.ts && echo done'), 'a')).not.toContain(
      'unscoped-check'
    )
  })

  it('flags an absolute or non-relative path in a check command', () => {
    expect(codesFor(withCommand('cd /Users/x/repo && vitest run src/a.test.ts'), 'a')).toContain(
      'non-relative-check'
    )
    expect(codesFor(withCommand(String.raw`C:\repo\x`), 'a')).toContain('non-relative-check')
  })

  it('flags a check command or task title that duplicates a declared gate', () => {
    const gates = [{ name: 'lint', command: 'pnpm lint' }]
    const commandResult = lint({
      gates,
      plan: [
        task('a', {
          criteria: [{ body: 'checked', shellCheckable: true, checkCommand: 'pnpm   lint' }]
        })
      ]
    })
    expect(codesFor(commandResult, 'a')).toContain('duplicates-gate')

    const titleResult = lint({
      gates,
      plan: [task('a', { title: 'Lint' })]
    })
    expect(codesFor(titleResult, 'a')).toContain('duplicates-gate')
  })
})

describe('lintObjectivePlan plan-level findings', () => {
  it('reports exactly one no-gate-declared finding when gates are undefined or empty', () => {
    const undefinedGates = lint({ gates: undefined, plan: [task('a')] })
    expect(codesFor(undefinedGates, null).filter((code) => code === 'no-gate-declared')).toEqual([
      'no-gate-declared'
    ])

    const emptyGates = lint({ gates: [], plan: [task('a')] })
    expect(codesFor(emptyGates, null).filter((code) => code === 'no-gate-declared')).toEqual([
      'no-gate-declared'
    ])
  })

  it('reports missing-assumptions only when assumptions are undefined', () => {
    const missing = lint({ assumptions: undefined, plan: [task('a')] })
    expect(codesFor(missing, null)).toContain('missing-assumptions')

    const declaredEmpty = lint({ assumptions: [], plan: [task('a')] })
    expect(codesFor(declaredEmpty, null)).not.toContain('missing-assumptions')
  })
})

describe('lintObjectivePlan conflict pairs', () => {
  it('flags overlapping territory with no dependency path either way', () => {
    const result = lint({
      writeTerritory: ['src/**'],
      plan: [task('a', { territory: ['src/a/**'] }), task('b', { territory: ['src/a/sub/**'] })]
    })
    expect(result.conflictPairs).toEqual([['a', 'b']])
    expect(codesFor(result, 'a')).toContain('conflict-pair')
  })

  it('clears the conflict once the later task depends on the earlier one', () => {
    const result = lint({
      writeTerritory: ['src/**'],
      plan: [
        task('a', { territory: ['src/a/**'] }),
        task('b', { territory: ['src/a/sub/**'], deps: ['a'] })
      ]
    })
    expect(result.conflictPairs).toEqual([])
  })

  it('clears the conflict for a transitive dependency path', () => {
    const result = lint({
      writeTerritory: ['src/**'],
      plan: [
        task('a', { territory: ['src/a/**'] }),
        task('c', { territory: ['docs/**'], deps: ['a'] }),
        task('b', { territory: ['src/a/sub/**'], deps: ['c'] })
      ]
    })
    expect(result.conflictPairs).toEqual([])
  })
})

describe('lintObjectivePlan chain metrics', () => {
  it('computes criticalPathLength as the longest dependency chain in nodes', () => {
    const result = lint({
      plan: [task('a'), task('b', { deps: ['a'] }), task('c', { deps: ['b'] })]
    })
    expect(result.criticalPathLength).toBe(3)
  })

  it('computes maxWidth as the widest depth level', () => {
    const result = lint({
      plan: [task('a'), task('b'), task('c')]
    })
    expect(result.maxWidth).toBe(3)
  })
})

describe('lintObjectivePlan ordering', () => {
  it('emits plan-level findings first, then per task in the documented code order', () => {
    const result = lintObjectivePlan({
      assumptions: undefined,
      gates: undefined,
      writeTerritory: ['src/**'],
      plan: [
        task('a', {
          territory: ['other/**/*.test.ts'],
          spec: 'Run pnpm test then done.',
          criteria: [
            { body: 'full suite', shellCheckable: true, checkCommand: 'vitest run' },
            {
              body: 'absolute path',
              shellCheckable: true,
              checkCommand: 'cd /Users/x/repo && vitest run src/a.test.ts'
            }
          ]
        }),
        task('b', { territory: ['other/**'], spec: 'do nothing' })
      ]
    })

    expect(result.findings.map((finding) => finding.code)).toEqual([
      'no-gate-declared',
      'missing-assumptions',
      'territory-outside-objective',
      'test-only-node',
      'full-suite-check',
      'full-suite-check',
      'unscoped-check',
      'non-relative-check',
      'conflict-pair',
      'territory-outside-objective'
    ])
    expect(result.findings.map((finding) => finding.taskKey)).toEqual([
      null,
      null,
      'a',
      'a',
      'a',
      'a',
      'a',
      'a',
      'a',
      'b'
    ])
  })
})

describe('lintObjectivePlan truncation', () => {
  it('caps findings at 256 and reports truncated', () => {
    const assumptions: ObjectivePlanAssumption[] = []
    const gates = [{ name: 'gate', command: 'echo ok' }]
    const plan = Array.from({ length: 300 }, (_, index) => task(`t${index}`))
    const result = lint({ assumptions, gates, plan })
    expect(result.findings).toHaveLength(256)
    expect(result.truncated).toBe(true)
    expect(result.findings.every((finding) => finding.code === 'missing-territory')).toBe(true)
  })
})
