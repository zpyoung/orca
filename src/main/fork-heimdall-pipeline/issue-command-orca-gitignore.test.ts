import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import { writeIssueCommand } from '../issue-command-file'

describe('issue command .orca gitignore fallback', () => {
  let root: string
  let repo: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-issue-ignore-fork-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    const globalConfig = join(root, 'gitconfig')
    writeFileSync(globalConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    await gitExecFileAsync(['init', '-q'], { cwd: repo })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('does not re-add .orca when the fallback sees .orca/*', async () => {
    writeFileSync(join(repo, '.gitignore'), '.orca/*\n')
    rmSync(join(repo, '.git'), { recursive: true, force: true })

    await writeIssueCommand(repo, 'local command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.orca/*\n')
  })
})
