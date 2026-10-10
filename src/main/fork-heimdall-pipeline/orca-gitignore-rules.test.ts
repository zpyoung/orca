import { describe, expect, it } from 'vitest'
import {
  gitignoreAlreadyCoversOrcaDir,
  reincludePipelines,
  rewriteBareOrcaLine
} from './orca-gitignore-rules'

describe('pipeline gitignore rules', () => {
  it.each([
    ['.orca\n', true],
    ['.orca/\n', true],
    ['.orca/*\n', true],
    ['node_modules\r\n.orca\r\n', true],
    ['/.orca\n', true],
    ['/.orca/\n', true],
    ['/.orca/*\n', true],
    ['src//.orca\n', false],
    ['.orcarc\n', false],
    ['# .orca\n', false],
    ['src/.orca\n', false]
  ] as const)('recognizes only a root .orca rule in %j', (content, expected) => {
    expect(gitignoreAlreadyCoversOrcaDir(content)).toBe(expected)
  })

  it('replaces each bare .orca line with the pipeline exception', () => {
    expect(rewriteBareOrcaLine('a\n.orca\nb\n')).toEqual({
      content: 'a\n.orca/*\n!.orca/pipelines/\nb\n',
      changed: true
    })
    expect(rewriteBareOrcaLine('.orca/\n')).toEqual({ content: '.orca/\n', changed: false })
    expect(rewriteBareOrcaLine('.orca\nx\n.orca')).toEqual({
      content: '.orca/*\n!.orca/pipelines/\nx\n.orca/*\n!.orca/pipelines/',
      changed: true
    })
  })

  it('treats a root-anchored /.orca like a bare .orca line', () => {
    expect(rewriteBareOrcaLine('/.orca\n')).toEqual({
      content: '.orca/*\n!.orca/pipelines/\n',
      changed: true
    })
    expect(rewriteBareOrcaLine('/.orca/\n')).toEqual({ content: '/.orca/\n', changed: false })
  })

  it('preserves CRLF for inserted ignore rules', () => {
    expect(rewriteBareOrcaLine('a\r\n.orca\r\nb\r\n')).toEqual({
      content: 'a\r\n.orca/*\r\n!.orca/pipelines/\r\nb\r\n',
      changed: true
    })
  })

  it('rewrites a directory rule and appends the exception on explicit re-include', () => {
    expect(reincludePipelines('.orca/\n')).toBe('.orca/*\n!.orca/pipelines/\n')
    expect(reincludePipelines('x')).toBe('x\n!.orca/pipelines/\n')
    expect(reincludePipelines('')).toBe('!.orca/pipelines/\n')
  })

  it('rewrites a root-anchored directory rule on explicit re-include', () => {
    expect(reincludePipelines('/.orca/\n')).toBe('.orca/*\n!.orca/pipelines/\n')
    expect(reincludePipelines('/.orca/\r\n')).toBe('.orca/*\r\n!.orca/pipelines/\r\n')
    expect(reincludePipelines('/.orca/*\n')).toBe('/.orca/*\n!.orca/pipelines/\n')
  })

  it('preserves unrelated rules and the file line ending on re-include', () => {
    expect(reincludePipelines('node_modules\r\n.orca/\r\n')).toBe(
      'node_modules\r\n.orca/*\r\n!.orca/pipelines/\r\n'
    )
  })
})
