import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { issuePipelineReportPath } from './pipeline-report-path'

describe('issuePipelineReportPath', () => {
  it('uses the host-specific storage root and separates attempts by fingerprint', () => {
    const fingerprint = 'pipeline-attempt:agent-1:0:0'
    const digest = createHash('sha256').update(fingerprint).digest('hex')
    const git = issuePipelineReportPath(
      { workspaceKind: 'git', gitDir: '/repo/.git', workspacePath: '/repo' },
      fingerprint
    )
    const folder = issuePipelineReportPath(
      { workspaceKind: 'folder', workspacePath: '/folder' },
      fingerprint
    )

    expect(git).toBe(join('/repo/.git', 'orca-heimdall', 'pipeline', 'reports', `${digest}.json`))
    expect(folder).toBe(
      join('/folder', '.orca', 'heimdall', 'pipeline', 'reports', `${digest}.json`)
    )
    expect(
      issuePipelineReportPath(
        { workspaceKind: 'folder', workspacePath: '/folder' },
        'pipeline-attempt:agent-1:0:1'
      )
    ).not.toBe(folder)
  })
})
