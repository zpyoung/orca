import { describe, expect, it } from 'vitest'
import { classifyPath, loadForkOwnershipManifest, matchGlob } from './fork-ownership-manifest.mjs'

function baseManifest(overrides = {}) {
  return {
    features: [],
    seams: [],
    exceptions: [],
    ...overrides
  }
}

function load(overrides = {}) {
  return loadForkOwnershipManifest(JSON.stringify(baseManifest(overrides)))
}

describe('loadForkOwnershipManifest', () => {
  it('loads an empty manifest', () => {
    expect(load()).toEqual({ features: [], seams: [], exceptions: [] })
  })

  it('loads a fully populated manifest', () => {
    const manifest = load({
      features: [
        { name: 'fork-native-chat-width', purpose: 'widens the native chat pane', globs: ['**/fork-native-chat-width/**'] }
      ],
      seams: [
        {
          path: 'src/main/index.ts',
          feature: 'fork-native-chat-width',
          kind: 'registration',
          lines: ["import './fork-native-chat-width'"]
        }
      ],
      exceptions: [
        {
          path: 'src/main/tail-reader.ts',
          reason: 'fork tail reader omits the upstream WSL-gate watch test',
          status: 'permanent'
        }
      ]
    })

    expect(manifest.features).toHaveLength(1)
    expect(manifest.seams).toHaveLength(1)
    expect(manifest.exceptions).toHaveLength(1)
  })

  it('throws on malformed JSON', () => {
    expect(() => loadForkOwnershipManifest('{not json')).toThrow()
  })

  it.each([['array', '[]'], ['string', '"nope"'], ['number', '1'], ['null', 'null']])(
    'throws when the top level is a %s, not an object',
    (_label, jsonText) => {
      expect(() => loadForkOwnershipManifest(jsonText)).toThrow()
    }
  )

  it.each(['features', 'seams', 'exceptions'])('throws when "%s" is missing', (key) => {
    const manifest = baseManifest()
    delete manifest[key]
    expect(() => loadForkOwnershipManifest(JSON.stringify(manifest))).toThrow(new RegExp(key))
  })

  it.each(['features', 'seams', 'exceptions'])('throws when "%s" is not an array', (key) => {
    expect(() => loadForkOwnershipManifest(JSON.stringify(baseManifest({ [key]: {} })))).toThrow(
      new RegExp(key)
    )
  })

  it('allows a feature with an empty globs array', () => {
    const manifest = load({
      features: [{ name: 'fork-pending-feature', purpose: 'not extracted yet', globs: [] }]
    })
    expect(manifest.features[0].globs).toEqual([])
  })

  it('throws on a feature missing a non-empty name', () => {
    expect(() =>
      load({ features: [{ name: '', purpose: 'x', globs: [] }] })
    ).toThrow(/name/)
  })

  it('throws on a feature missing a non-empty purpose', () => {
    expect(() =>
      load({ features: [{ name: 'fork-x', purpose: '', globs: [] }] })
    ).toThrow(/purpose/)
  })

  it('throws on a feature whose globs field is not an array', () => {
    expect(() =>
      load({ features: [{ name: 'fork-x', purpose: 'x', globs: 'not-an-array' }] })
    ).toThrow(/globs/)
  })

  it('throws on duplicate feature names', () => {
    expect(() =>
      load({
        features: [
          { name: 'fork-x', purpose: 'a', globs: [] },
          { name: 'fork-x', purpose: 'b', globs: [] }
        ]
      })
    ).toThrow(/duplicate/i)
  })

  it('throws on an invalid glob pattern inside a feature', () => {
    expect(() =>
      load({ features: [{ name: 'fork-x', purpose: 'x', globs: ['fo?o/**'] }] })
    ).toThrow()
  })

  it('throws on a seam missing a non-empty path', () => {
    expect(() =>
      load({ seams: [{ path: '', feature: 'fork-infra', kind: 'registration', lines: ['x'] }] })
    ).toThrow(/path/)
  })

  it('throws on a seam missing a non-empty feature', () => {
    expect(() =>
      load({ seams: [{ path: 'a.ts', feature: '', kind: 'registration', lines: ['x'] }] })
    ).toThrow(/feature/)
  })

  it('throws when a seam references an unknown feature', () => {
    expect(() =>
      load({
        seams: [{ path: 'a.ts', feature: 'fork-does-not-exist', kind: 'registration', lines: ['x'] }]
      })
    ).toThrow(/fork-does-not-exist/)
  })

  it('allows a seam that references the literal "fork-infra" feature', () => {
    const manifest = load({
      seams: [{ path: 'a.ts', feature: 'fork-infra', kind: 'registration', lines: ['x'] }]
    })
    expect(manifest.seams[0].feature).toBe('fork-infra')
  })

  it('allows a seam that references a declared feature', () => {
    const manifest = load({
      features: [{ name: 'fork-x', purpose: 'x', globs: [] }],
      seams: [{ path: 'a.ts', feature: 'fork-x', kind: 'registration', lines: ['x'] }]
    })
    expect(manifest.seams[0].feature).toBe('fork-x')
  })

  it.each(['registration', 'import-swap', 'passthrough'])('allows seam kind "%s"', (kind) => {
    const manifest = load({
      seams: [{ path: 'a.ts', feature: 'fork-infra', kind, lines: ['x'] }]
    })
    expect(manifest.seams[0].kind).toBe(kind)
  })

  it('throws on an invalid seam kind', () => {
    expect(() =>
      load({ seams: [{ path: 'a.ts', feature: 'fork-infra', kind: 'bogus', lines: ['x'] }] })
    ).toThrow(/kind/)
  })

  it('throws when a seam has no lines', () => {
    expect(() =>
      load({ seams: [{ path: 'a.ts', feature: 'fork-infra', kind: 'registration', lines: [] }] })
    ).toThrow(/lines/)
  })

  it('throws when a seam lines entry is an empty string', () => {
    expect(() =>
      load({ seams: [{ path: 'a.ts', feature: 'fork-infra', kind: 'registration', lines: [''] }] })
    ).toThrow(/lines/)
  })

  it('throws when a seam lines entry is not a string', () => {
    expect(() =>
      load({ seams: [{ path: 'a.ts', feature: 'fork-infra', kind: 'registration', lines: [42] }] })
    ).toThrow(/lines/)
  })

  it('throws on an exception missing a non-empty path', () => {
    expect(() =>
      load({ exceptions: [{ path: '', reason: 'x', status: 'permanent' }] })
    ).toThrow(/path/)
  })

  it('throws on an exception missing a non-empty reason', () => {
    expect(() =>
      load({ exceptions: [{ path: 'a.ts', reason: '', status: 'permanent' }] })
    ).toThrow(/reason/)
  })

  it('throws on an invalid exception status', () => {
    expect(() =>
      load({ exceptions: [{ path: 'a.ts', reason: 'x', status: 'bogus' }] })
    ).toThrow(/status/)
  })

  it.each(['permanent', 'pending-decision'])(
    'throws when status is "%s" and a ledger is present',
    (status) => {
      expect(() =>
        load({
          exceptions: [{ path: 'a.ts', reason: 'x', status, ledger: 'docs/fork-upstreaming.md#a' }]
        })
      ).toThrow(/ledger/)
    }
  )

  it('throws when status is "pending-upstream" and no ledger is present', () => {
    expect(() =>
      load({ exceptions: [{ path: 'a.ts', reason: 'x', status: 'pending-upstream' }] })
    ).toThrow(/ledger/)
  })

  it('allows "pending-upstream" with a ledger', () => {
    const manifest = load({
      exceptions: [
        { path: 'a.ts', reason: 'x', status: 'pending-upstream', ledger: 'docs/fork-upstreaming.md#a' }
      ]
    })
    expect(manifest.exceptions[0].ledger).toBe('docs/fork-upstreaming.md#a')
  })

  it('allows "permanent" with no ledger', () => {
    const manifest = load({ exceptions: [{ path: 'a.ts', reason: 'x', status: 'permanent' }] })
    expect(manifest.exceptions[0].status).toBe('permanent')
  })

  it('throws when exceptions.deleted is present and not a boolean', () => {
    expect(() =>
      load({
        exceptions: [{ path: 'a.ts', reason: 'x', status: 'permanent', deleted: 'yes' }]
      })
    ).toThrow(/deleted/)
  })

  it('allows exceptions.deleted as a boolean', () => {
    const manifest = load({
      exceptions: [{ path: 'a.ts', reason: 'x', status: 'permanent', deleted: true }]
    })
    expect(manifest.exceptions[0].deleted).toBe(true)
  })

  it('throws when a path appears in both seams and exceptions', () => {
    expect(() =>
      load({
        seams: [{ path: 'a.ts', feature: 'fork-infra', kind: 'registration', lines: ['x'] }],
        exceptions: [{ path: 'a.ts', reason: 'x', status: 'permanent' }]
      })
    ).toThrow(/a\.ts/)
  })
})

describe('classifyPath precedence', () => {
  // classifyPath applies precedence to whatever manifest object it is given, so
  // these fixtures deliberately construct overlaps the loader's own invariants
  // would reject (e.g. one path in both seams and exceptions) to exercise
  // classifyPath's ordering in isolation from load-time validation.
  const feature = { name: 'fork-x', purpose: 'x', globs: ['fork-x/**'] }
  const seam = { path: 'shared.ts', feature: 'fork-infra', kind: 'registration', lines: ['x'] }
  const exception = { path: 'shared.ts', reason: 'x', status: 'permanent' }

  it('classifies an exact exceptions match', () => {
    const manifest = { features: [], seams: [], exceptions: [exception] }
    expect(classifyPath(manifest, 'shared.ts')).toEqual({ class: 'exception', entry: exception })
  })

  it('classifies an exact seams match', () => {
    const manifest = { features: [], seams: [seam], exceptions: [] }
    expect(classifyPath(manifest, 'shared.ts')).toEqual({ class: 'seam', entry: seam })
  })

  it('classifies a feature glob match', () => {
    const manifest = { features: [feature], seams: [], exceptions: [] }
    expect(classifyPath(manifest, 'fork-x/a.ts')).toEqual({ class: 'feature', entry: feature })
  })

  it('classifies an unmatched path as upstream', () => {
    const manifest = { features: [feature], seams: [seam], exceptions: [exception] }
    expect(classifyPath(manifest, 'upstream/only.ts')).toEqual({ class: 'upstream' })
  })

  it('prefers an exception over a seam at the same path', () => {
    const manifest = { features: [], seams: [seam], exceptions: [exception] }
    expect(classifyPath(manifest, 'shared.ts')).toEqual({ class: 'exception', entry: exception })
  })

  it('prefers an exception over a matching feature glob at the same path', () => {
    const globFeature = { name: 'fork-x', purpose: 'x', globs: ['shared.ts'] }
    const manifest = { features: [globFeature], seams: [], exceptions: [exception] }
    expect(classifyPath(manifest, 'shared.ts')).toEqual({ class: 'exception', entry: exception })
  })

  it('prefers a seam over a matching feature glob at the same path', () => {
    const globFeature = { name: 'fork-x', purpose: 'x', globs: ['shared.ts'] }
    const manifest = { features: [globFeature], seams: [seam], exceptions: [] }
    expect(classifyPath(manifest, 'shared.ts')).toEqual({ class: 'seam', entry: seam })
  })

  it('prefers an exception over both a seam and a feature glob at the same path', () => {
    const globFeature = { name: 'fork-x', purpose: 'x', globs: ['shared.ts'] }
    const manifest = { features: [globFeature], seams: [seam], exceptions: [exception] }
    expect(classifyPath(manifest, 'shared.ts')).toEqual({ class: 'exception', entry: exception })
  })
})

describe('matchGlob grammar', () => {
  it('matches a leading **/ across multiple directories', () => {
    expect(matchGlob('**/foo.ts', 'a/b/foo.ts')).toBe(true)
  })

  it('matches a leading **/ across zero directories', () => {
    expect(matchGlob('**/foo.ts', 'foo.ts')).toBe(true)
  })

  it('matches a middle **/ across multiple directories', () => {
    expect(matchGlob('a/**/b.ts', 'a/x/y/b.ts')).toBe(true)
  })

  it('matches a middle **/ across zero directories', () => {
    expect(matchGlob('a/**/b.ts', 'a/b.ts')).toBe(true)
  })

  it('does not match when the literal segments around **/ differ', () => {
    expect(matchGlob('a/**/b.ts', 'a/x/c.ts')).toBe(false)
  })

  // load-bearing: a trailing "**" segment must match both zero leading
  // directories and a non-trivial leading path, matching the manifest's own
  // documented feature-glob convention.
  it('matches a trailing ** with a zero-depth prefix', () => {
    expect(matchGlob('**/fork-native-chat-width/**', 'fork-native-chat-width/x.ts')).toBe(true)
  })

  it('matches a trailing ** with a multi-directory prefix', () => {
    expect(
      matchGlob(
        '**/fork-native-chat-width/**',
        'src/renderer/src/components/native-chat/fork-native-chat-width/x.ts'
      )
    ).toBe(true)
  })

  it('matches * within a single path segment', () => {
    expect(matchGlob('fork-*-chat-width/x.ts', 'fork-native-chat-width/x.ts')).toBe(true)
  })

  it('does not let * cross a / boundary', () => {
    expect(matchGlob('fork-*/x.ts', 'fork-a/b/x.ts')).toBe(false)
  })

  it('matches a literal path with no metacharacters', () => {
    expect(matchGlob('docs/architecture/foo.md', 'docs/architecture/foo.md')).toBe(true)
  })

  it('does not match a literal path against a different path', () => {
    expect(matchGlob('docs/architecture/foo.md', 'docs/architecture/bar.md')).toBe(false)
  })

  it('rejects "?" as unsupported syntax', () => {
    expect(() => matchGlob('fo?o/x.ts', 'foo/x.ts')).toThrow()
  })

  it('rejects brace expansion as unsupported syntax', () => {
    expect(() => matchGlob('{a,b}/x.ts', 'a/x.ts')).toThrow()
  })

  it('rejects a character class as unsupported syntax', () => {
    expect(() => matchGlob('[a-z]/x.ts', 'a/x.ts')).toThrow()
  })

  it('rejects negation as unsupported syntax', () => {
    expect(() => matchGlob('!foo/x.ts', 'foo/x.ts')).toThrow()
  })

  it('rejects "**" glued to the end of a literal segment', () => {
    expect(() => matchGlob('foo**/x.ts', 'foo/x.ts')).toThrow()
  })

  it('rejects "**" glued to the start of a literal segment', () => {
    expect(() => matchGlob('x.ts/**foo', 'x.ts/foo')).toThrow()
  })

  it('rejects "**" glued inside a literal segment', () => {
    expect(() => matchGlob('a**b/x.ts', 'ab/x.ts')).toThrow()
  })
})
