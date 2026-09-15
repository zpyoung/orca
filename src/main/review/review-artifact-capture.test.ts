import { describe, expect, it } from 'vitest'
import {
  captureReviewArtifactOids,
  captureReviewArtifactTree,
  compareReviewArtifactCaptures,
  hashReviewArtifactTree,
  isReviewArtifactPathExcluded,
  reviewArtifactExclusions,
  type ReviewArtifactStat,
  type ReviewArtifactTreeReader
} from './review-artifact-capture'

type MemoryNode =
  | { kind: 'directory'; children: Record<string, MemoryNode>; mode?: number }
  | { kind: 'file'; content: string; mode?: number }
  | { kind: 'symlink'; target: string; mode?: number }

function memoryReader(root: MemoryNode): ReviewArtifactTreeReader {
  const lookup = (path: string): MemoryNode => {
    let node = root
    for (const segment of path.split('/').filter(Boolean)) {
      if (node.kind !== 'directory' || !node.children[segment]) {
        throw new Error(`missing ${path}`)
      }
      node = node.children[segment]
    }
    return node
  }
  return {
    async readDirectory(path) {
      const node = lookup(path)
      if (node.kind !== 'directory') {
        throw new Error(`not a directory: ${path}`)
      }
      return Object.keys(node.children)
    },
    async lstat(path): Promise<ReviewArtifactStat> {
      const node = lookup(path)
      if (node.kind === 'file') {
        return { kind: node.kind, size: Buffer.byteLength(node.content), mode: node.mode }
      }
      return { kind: node.kind, mode: node.mode }
    },
    async readFile(path) {
      const node = lookup(path)
      if (node.kind !== 'file') {
        throw new Error(`not a file: ${path}`)
      }
      return Buffer.from(node.content)
    },
    async readSymbolicLink(path) {
      const node = lookup(path)
      if (node.kind !== 'symlink') {
        throw new Error(`not a symlink: ${path}`)
      }
      return node.target
    },
    joinPath(parent, name) {
      return parent ? `${parent}/${name}` : name
    }
  }
}

describe('review artifact tree capture', () => {
  it('is deterministic, length-framed, and records symlink targets without following them', async () => {
    const first: MemoryNode = {
      kind: 'directory',
      children: {
        z: { kind: 'file', content: 'tail' },
        link: { kind: 'symlink', target: '../outside' },
        a: { kind: 'file', content: 'head' }
      }
    }
    const reordered: MemoryNode = {
      kind: 'directory',
      children: {
        a: { kind: 'file', content: 'head' },
        link: { kind: 'symlink', target: '../outside' },
        z: { kind: 'file', content: 'tail' }
      }
    }
    const captured = await captureReviewArtifactTree('', memoryReader(first))
    const recaptured = await captureReviewArtifactTree('', memoryReader(reordered))

    expect(captured.hash).toBe(recaptured.hash)
    expect(captured.entries.map((entry) => entry.path)).toEqual(['a', 'link', 'z'])
    expect(captured.entries.find((entry) => entry.path === 'link')?.kind).toBe('symlink')
    expect(hashReviewArtifactTree([{ path: 'a', kind: 'file', content: 'bc' }])).not.toBe(
      hashReviewArtifactTree([{ path: 'ab', kind: 'file', content: 'c' }])
    )
  })

  it('always excludes the review run root and declared generated outputs', async () => {
    const tree: MemoryNode = {
      kind: 'directory',
      children: {
        src: { kind: 'file', content: 'kept' },
        coverage: {
          kind: 'directory',
          children: { 'out.json': { kind: 'file', content: 'ignored' } }
        },
        '.orca-review': {
          kind: 'directory',
          children: { runs: { kind: 'file', content: 'ignored' } }
        }
      }
    }
    const captured = await captureReviewArtifactTree('', memoryReader(tree), ['coverage/**'])

    expect(captured.entries.map((entry) => entry.path)).toEqual(['src'])
    expect(captured.exclusions).toEqual(['.orca-review/**', 'coverage/**'])
    expect(isReviewArtifactPathExcluded('.orca-review', captured.exclusions)).toBe(true)
    expect(isReviewArtifactPathExcluded('coverage/nested/out.json', captured.exclusions)).toBe(true)
    expect(reviewArtifactExclusions(['.orca-review/**'])).toEqual(['.orca-review/**'])
  })

  it('reports additions, changes, deletions, and mode-only changes', async () => {
    const before: MemoryNode = {
      kind: 'directory',
      children: {
        changed: { kind: 'file', content: 'old' },
        deleted: { kind: 'file', content: 'gone' },
        mode: { kind: 'file', content: 'same', mode: 0o644 }
      }
    }
    const after: MemoryNode = {
      kind: 'directory',
      children: {
        added: { kind: 'file', content: 'new' },
        changed: { kind: 'file', content: 'new' },
        mode: { kind: 'file', content: 'same', mode: 0o755 }
      }
    }
    const result = compareReviewArtifactCaptures(
      await captureReviewArtifactTree('', memoryReader(before)),
      await captureReviewArtifactTree('', memoryReader(after))
    )

    expect(result).toMatchObject({
      stale: true,
      reason: 'hash-mismatch',
      addedPaths: ['added'],
      changedPaths: ['changed', 'mode'],
      deletedPaths: ['deleted'],
      unreviewedPaths: ['added']
    })
  })

  it('only marks OID captures stale when a watched named ref moves', () => {
    const captured = captureReviewArtifactOids('base', 'head', ['head'])
    expect(
      compareReviewArtifactCaptures(captured, captureReviewArtifactOids('other', 'head', ['head']))
        .stale
    ).toBe(false)
    expect(
      compareReviewArtifactCaptures(captured, captureReviewArtifactOids('base', 'other', ['head']))
    ).toMatchObject({
      stale: true,
      reason: 'ref-moved'
    })
  })
})
