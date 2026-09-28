import { describe, expect, it } from 'vitest'
import {
  ActionOutcomeSchema,
  ObjectiveFailureClassSchema,
  createReportValidationProvenance,
  resolveByExpectedState
} from './effect-certainty'

describe('resolveByExpectedState', () => {
  it('classifies the expected after-state as landed', () => {
    expect(resolveByExpectedState('after', 'before', 'after')).toBe('landed')
  })

  it('classifies the unchanged before-state as not landed', () => {
    expect(resolveByExpectedState('before', 'before', 'after')).toBe('not-landed')
  })

  it('keeps every third value indeterminate', () => {
    expect(resolveByExpectedState('someone-else-moved-it', 'before', 'after')).toBe('indeterminate')
  })

  it('does not accept process-liveness vocabulary as effect certainty', () => {
    expect(ActionOutcomeSchema.safeParse({ effect: 'unverifiable' }).success).toBe(false)
  })
})

describe('ObjectiveFailureClassSchema', () => {
  it('accepts exactly the three failure classes', () => {
    for (const value of ['infra', 'environment', 'criteria']) {
      expect(ObjectiveFailureClassSchema.safeParse(value).success).toBe(true)
    }
    expect(ObjectiveFailureClassSchema.safeParse('unknown-cause').success).toBe(false)
  })
})

describe('ActionOutcomeSchema failureClass', () => {
  it('carries an optional failure class without requiring one', () => {
    expect(
      ActionOutcomeSchema.safeParse({ effect: 'not-landed', failureClass: 'infra' }).success
    ).toBe(true)
    expect(ActionOutcomeSchema.safeParse({ effect: 'not-landed' }).success).toBe(true)
    expect(
      ActionOutcomeSchema.safeParse({ effect: 'not-landed', failureClass: 'bogus' }).success
    ).toBe(false)
  })
})

describe('report validation provenance', () => {
  it('bounds diagnostic copies and marks every abbreviation without mutating caller evidence', () => {
    const detail = 'x'.repeat(5_000)
    const sourceCode = 'c'.repeat(1_200)
    const files = Array.from({ length: 258 }, (_, index) => `src/${index}.ts`)
    const provenance = createReportValidationProvenance({
      status: 'rejected',
      code: 'malformed',
      sourceCode,
      role: 'implementer',
      dispatchId: 'dispatch-1',
      taskKey: 'task-1',
      reportPath: `/workspace/${'r'.repeat(9_000)}.json`,
      detail,
      reportedFiles: files,
      hostVerifiable: true
    })

    expect(provenance.detail).toHaveLength(4_096)
    expect(provenance.detail).toMatch(/\[abbreviated\]$/)
    expect(provenance.detailAbbreviated).toBe(true)
    expect(provenance.reportPathAbbreviated).toBe(true)
    expect(provenance.sourceCode).toHaveLength(1_024)
    expect(provenance.sourceCode).toMatch(/\[abbreviated\]$/)
    expect(provenance.sourceCodeAbbreviated).toBe(true)
    expect(provenance.reportedFiles).toHaveLength(256)
    expect(provenance.reportedFilesOmitted).toBe(2)
    expect(provenance.reportedFilesAbbreviated).toBe(true)
    expect(detail).toHaveLength(5_000)
    expect(sourceCode).toHaveLength(1_200)
    expect(files).toHaveLength(258)
  })
})
