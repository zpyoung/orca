import { describe, expect, it } from 'vitest'
import { assemblePipelineDispatchPrompt } from './pipeline-dispatch-prompt'

describe('assemblePipelineDispatchPrompt (T10)', () => {
  it('returns the snapshot prompt unchanged with no suffix when there are no dependencies', () => {
    const result = assemblePipelineDispatchPrompt({ snapshotPrompt: 'Reproduce the bug.', dependencies: [] })
    expect(result).toBe('Reproduce the bug.')
  })

  it('appends the dependency-results section byte-exact for a single dependency', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Fix the bug.',
      dependencies: [{ nodeId: 'repro', result: 'Reproduced with test/repro.spec.ts.' }]
    })
    expect(result).toBe(
      'Fix the bug.\n\n' +
        '## Results of completed dependencies\n\n' +
        '### Node "repro"\n' +
        'Reproduced with test/repro.spec.ts.'
    )
  })

  it('renders the literal "(no result recorded)" line when a dependency result is null', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Verify the fix.',
      dependencies: [{ nodeId: 'fix', result: null }]
    })
    expect(result).toBe(
      'Verify the fix.\n\n' + '## Results of completed dependencies\n\n' + '### Node "fix"\n' + '(no result recorded)'
    )
  })

  it('orders multiple dependencies exactly as given (the needs order)', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Open the PR.',
      dependencies: [
        { nodeId: 'repro', result: 'repro result' },
        { nodeId: 'fix', result: null },
        { nodeId: 'test', result: 'test result' }
      ]
    })
    expect(result).toBe(
      'Open the PR.\n\n' +
        '## Results of completed dependencies\n\n' +
        '### Node "repro"\nrepro result\n\n' +
        '### Node "fix"\n(no result recorded)\n\n' +
        '### Node "test"\ntest result'
    )
  })

  it('preserves a multi-line result verbatim', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Verify.',
      dependencies: [{ nodeId: 'fix', result: 'line one\nline two' }]
    })
    expect(result).toBe('Verify.\n\n## Results of completed dependencies\n\n### Node "fix"\nline one\nline two')
  })

  it('collapses a single trailing newline on the prompt to exactly one blank line (YAML `|` block scalars)', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Commit the fix.\n',
      dependencies: [{ nodeId: 'fix', result: 'fix result' }]
    })
    expect(result).toBe('Commit the fix.\n\n## Results of completed dependencies\n\n### Node "fix"\nfix result')
  })

  it('collapses several trailing newlines on the prompt to exactly one blank line', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Commit the fix.\n\n\n',
      dependencies: [{ nodeId: 'fix', result: 'fix result' }]
    })
    expect(result).toBe('Commit the fix.\n\n## Results of completed dependencies\n\n### Node "fix"\nfix result')
  })

  it('normalizes only the trailing line-break run, preserving trailing spaces on the prompt itself', () => {
    const result = assemblePipelineDispatchPrompt({
      snapshotPrompt: 'Run the suite:   \n',
      dependencies: [{ nodeId: 'fix', result: 'fix result' }]
    })
    expect(result).toBe(
      'Run the suite:   \n\n## Results of completed dependencies\n\n### Node "fix"\nfix result'
    )
  })

  it('leaves the snapshot prompt completely unchanged, trailing newlines included, when there are no dependencies', () => {
    const result = assemblePipelineDispatchPrompt({ snapshotPrompt: 'Commit the fix.\n\n\n', dependencies: [] })
    expect(result).toBe('Commit the fix.\n\n\n')
  })
})
