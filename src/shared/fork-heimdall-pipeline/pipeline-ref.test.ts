import { describe, expect, it } from 'vitest'
import { parsePipelineRef } from './pipeline-ref'

describe('parsePipelineRef', () => {
  it('recognizes built-in, personal, repository and file references', () => {
    expect(parsePipelineRef('builtin:objective')).toEqual({ scope: 'builtin', id: 'objective' })
    expect(parsePipelineRef('user:bugfix')).toEqual({ scope: 'user', id: 'bugfix' })
    expect(parsePipelineRef('bugfix')).toEqual({ scope: 'repo', id: 'bugfix' })
    expect(parsePipelineRef('.orca/pipelines/bugfix.yaml')).toEqual({
      scope: 'path',
      path: '.orca/pipelines/bugfix.yaml'
    })
    expect(parsePipelineRef('pipelines/bugfix.yaml')).toEqual({
      scope: 'path',
      path: 'pipelines/bugfix.yaml'
    })
  })

  it('returns an explanatory error for malformed references', () => {
    for (const ref of ['builtin:', 'Bugfix', '.orca/pipelines/../bugfix.yaml']) {
      const result = parsePipelineRef(ref)
      expect('error' in result && result.error.length > 0).toBe(true)
    }
  })
})
