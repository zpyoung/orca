import { describe, expect, it } from 'vitest'
import { parseLedgerImportSources } from './ledger-import-parser'

const base = { kind: 'project' as const, id: 'project-1', host: 'ssh:builder' }

describe('legacy ledger import parser', () => {
  it('parses multiline labeled records and structures locations', () => {
    const result = parseLedgerImportSources(
      [
        {
          path: 'BUGS.md',
          content: [
            '## BUG-3: Escaped parser',
            'Title: Escaped parser',
            'File: src/parser.ts:17',
            'Description: First paragraph',
            '  second paragraph',
            'Severity: HIGH'
          ].join('\n')
        }
      ],
      base
    )
    expect(result.skipped).toEqual([])
    expect(result.records[0].content).toMatchObject({
      title: 'Escaped parser',
      description: 'First paragraph\nsecond paragraph',
      severity: 'high',
      file: { path: 'src/parser.ts', line: 17, base }
    })
  })

  it('preserves escaped pipes and code spans in tables', () => {
    const result = parseLedgerImportSources(
      [
        {
          path: 'DEFERRED.md',
          content: [
            '| ID | Title | Why deferred | Priority |',
            '| --- | --- | --- | --- |',
            '| DEF-2 | `one | two` | a\\|b | LOW |'
          ].join('\n')
        }
      ],
      base
    )
    expect(result.skipped).toEqual([])
    expect(result.records[0].content).toMatchObject({
      title: 'one | two',
      why_deferred: 'a|b',
      priority: 'low'
    })
  })

  it('imports table rows alongside labeled records and uses each explicit id', () => {
    const result = parseLedgerImportSources(
      [
        {
          path: 'BUGS.md',
          content: [
            '| ID | Title | File | Description | Severity |',
            '| --- | --- | --- | --- | --- |',
            '| BUG-2 | Table bug | table.ts:2 | table description | low |',
            '',
            '## BUG-3: Labeled bug',
            'Title: Labeled bug',
            'File: labeled.ts:3',
            'Description: labeled description',
            'Severity: high'
          ].join('\n')
        }
      ],
      base
    )
    expect(result.skipped).toEqual([])
    expect(result.records).toHaveLength(2)
    expect(result.records.map((record) => record.legacyId)).toEqual(['BUG-2', 'BUG-3'])
  })

  it('keeps Windows paths and nested headings/code in field content', () => {
    const result = parseLedgerImportSources(
      [
        {
          path: 'BUGS.md',
          content: [
            '## BUG-4: Windows',
            'Title: Windows',
            'File: C:\\repo\\src\\a.ts:9',
            'Description: before',
            '### Implementation note',
            '  ```ts',
            '  const value = "x"',
            '  ```',
            'after',
            'Severity: low'
          ].join('\n')
        }
      ],
      base
    )
    expect(result.skipped).toEqual([])
    expect(result.records[0].content).toMatchObject({
      file: { path: 'C:\\repo\\src\\a.ts', line: 9 }
    })
    expect(result.records[0].content.description).toContain('Implementation note')
  })

  it('skips non-ADR records without explicit ids and duplicate table headers', () => {
    const result = parseLedgerImportSources(
      [
        {
          path: 'DEFERRED.md',
          content: [
            '| Title | title | Why deferred | Priority |',
            '| --- | --- | --- | --- |',
            '| one | one | reason | low |',
            '',
            '## No id',
            'Title: No id',
            'Why deferred: reason',
            'Priority: low'
          ].join('\n')
        }
      ],
      base
    )
    expect(result.records).toEqual([])
    expect(result.skipped.length).toBeGreaterThanOrEqual(2)
  })

  it('skips every record sharing an ambiguous anchor before import', () => {
    const source = {
      path: 'BUGS.md',
      content: [
        '## BUG-1: First',
        'Title: First',
        'File: one.ts:1',
        'Description: one',
        'Severity: low',
        '## BUG-1: Second',
        'Title: Second',
        'File: two.ts:2',
        'Description: two',
        'Severity: low'
      ].join('\n')
    }
    const result = parseLedgerImportSources([source], base)
    expect(result.records).toEqual([])
    expect(result.skipped.filter((skip) => skip.reason.includes('duplicate'))).toHaveLength(1)
  })

  it('uses the ADR path when frontmatter has no legacy id', () => {
    const result = parseLedgerImportSources(
      [
        {
          path: 'docs/adr/001-parser.md',
          content: [
            '---',
            'title: Parser decision',
            '---',
            '# Parser decision',
            '## Context',
            'We need multiline context.',
            '## Decision',
            'Use a bounded parser.',
            '## Consequences',
            'No arbitrary markdown regex.',
            '## Status',
            'accepted'
          ].join('\n')
        }
      ],
      base
    )
    expect(result.skipped).toEqual([])
    expect(result.records[0]).toMatchObject({
      type: 'decision',
      legacyId: undefined,
      sourcePath: 'docs/adr/001-parser.md'
    })
    expect(result.records[0].content).toMatchObject({
      title: 'Parser decision',
      status: 'accepted',
      context: 'We need multiline context.'
    })
    expect(result.records[0].anchor).toContain('docs/adr/001-parser.md')
  })
})
