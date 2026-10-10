import { describe, expect, it } from 'vitest'
import { lintTaskList, type PipelineTask } from './task-list'

function task(id: string, deps?: string[], territory?: string[]): PipelineTask {
  return {
    id,
    title: id,
    spec: `Implement ${id}`,
    ...(deps === undefined ? {} : { deps }),
    ...(territory === undefined ? {} : { territory })
  }
}

describe('lintTaskList', () => {
  it('reports empty, oversized, duplicate, unknown-dependency and cyclic lists', () => {
    expect(lintTaskList([]).errors).toEqual([{ code: 'empty' }])
    expect(
      lintTaskList(Array.from({ length: 21 }, (_, index) => task(`t${index}`))).errors
    ).toContainEqual({
      code: 'too-many'
    })
    expect(lintTaskList([task('a'), task('a')]).errors).toContainEqual({
      code: 'duplicate-id',
      taskId: 'a'
    })
    expect(lintTaskList([task('a', ['zz'])]).errors).toContainEqual({
      code: 'unknown-dep',
      taskId: 'a',
      dependencyId: 'zz'
    })
    expect(
      lintTaskList([task('a', ['b']), task('b', ['a'])]).errors.map((error) => error.code)
    ).toContain('cycle')
  })

  it('warns for unordered shared territory but not for dependent tasks', () => {
    const unordered = lintTaskList([
      task('t1'),
      task('t2', undefined, ['./canvas-store.ts']),
      task('t3', undefined, ['canvas-store.ts'])
    ])
    expect(unordered.errors).toEqual([])
    expect(unordered.warnings).toEqual([
      { code: 'territory-overlap', taskIds: ['t2', 't3'], paths: ['canvas-store.ts'] }
    ])

    const ordered = lintTaskList([
      task('t2', undefined, ['./canvas-store.ts']),
      task('t3', ['t2'], ['canvas-store.ts'])
    ])
    expect(ordered.errors).toEqual([])
    expect(ordered.warnings).toEqual([])
  })
})
