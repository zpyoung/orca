import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRelayLinkTarget } from './link-target-request'

describe('relay link-target request', () => {
  it('returns the literal target of a dangling symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-readlink-'))
    try {
      const literalTarget = '../missing/target'
      const linkPath = join(root, 'dangling-link')
      await symlink(literalTarget, linkPath)

      await expect(readRelayLinkTarget({ filePath: linkPath })).resolves.toBe(literalTarget)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a symlink-to-directory target without following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-readlink-'))
    try {
      const directoryName = 'target-directory'
      await mkdir(join(root, directoryName))
      const linkPath = join(root, 'directory-link')
      await symlink(directoryName, linkPath)

      await expect(readRelayLinkTarget({ filePath: linkPath })).resolves.toBe(directoryName)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([undefined, null, [], 42, { filePath: 42 }, { filePath: '' }])(
    'rejects malformed request parameters (%s)',
    async (params) => {
      await expect(readRelayLinkTarget(params)).rejects.toThrow('fs.readlink requires a filePath')
    }
  )
})
