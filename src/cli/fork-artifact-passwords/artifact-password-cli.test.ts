import { describe, expect, it } from 'vitest'
import type { ArtifactListItem } from '../../shared/artifacts'
import { parseArgs } from '../args'
import { ARTIFACT_COMMAND_SPECS } from '../specs/artifacts'
import { formatArtifactList } from '../artifact-format'
import { artifactShareRpcMethod, formatArtifactSharedWithPassword } from './artifact-password-cli'

const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'artifact-a',
    title: 'Protected Orca artifact',
    originalFileName: 'Protected Orca artifact.html',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-09-28T00:00:00.000Z',
    byteSize: 100,
    deletedAt: null
  },
  shareUrl: 'https://share.onorca.dev/a/artifact-a',
  protection: {
    state: 'protected-available',
    passphrase: 'abacus abdomen abdominal abide abiding ability'
  }
}

describe('artifact password CLI', () => {
  it('parses --protect as a boolean without consuming the file', () => {
    const parsed = parseArgs(
      ['artifacts', 'share', '--protect', './report.html'],
      ARTIFACT_COMMAND_SPECS.map((spec) => spec.path)
    )

    expect(parsed.commandPath).toEqual(['artifacts', 'share', './report.html'])
    expect(parsed.flags.get('protect')).toBe(true)
    expect(artifactShareRpcMethod(parsed.flags)).toBe('artifacts.shareProtected')
  })

  it('prints the link and generated passphrase separately', () => {
    const output = formatArtifactSharedWithPassword(item)

    expect(output).toContain(`${item.shareUrl}\nPassphrase:`)
    expect(output).toContain(item.protection?.passphrase)
    expect(output).toContain('Send the link and passphrase separately')
  })

  it('does not add a password-valued argument', () => {
    const share = ARTIFACT_COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'artifacts share')
    expect(share?.allowedFlags).toContain('protect')
    expect(share?.allowedFlags).not.toContain('password')
    expect(share?.allowedFlags).not.toContain('passphrase')
  })

  it('uses the local protected display name in list output', () => {
    const output = formatArtifactList([
      {
        ...item,
        local: {
          sourceKey: '/repo/financial-plan.html',
          displayName: 'financial-plan.html',
          sourceContentType: 'text/html',
          protection: 'protected-available'
        }
      }
    ])

    expect(output).toContain('financial-plan.html')
    expect(output).not.toContain('Protected Orca artifact\n')
  })
})
