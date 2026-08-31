import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareRemoteArtifactCliInput } from '../remote-artifact-cli-input'

const paths: string[] = []

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('protected artifact SSH forwarding', () => {
  it('keeps --protect boolean and forwards the selected file content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-protected-artifact-relay-'))
    paths.push(cwd)
    await writeFile(join(cwd, 'report.md'), '# Protected', 'utf8')

    await expect(
      prepareRemoteArtifactCliInput(['artifacts', 'share', '--protect', 'report.md'], cwd)
    ).resolves.toEqual({
      stdin: '# Protected',
      artifactInput: {
        sourceKey: join(cwd, 'report.md'),
        fileName: 'report.md',
        contentType: 'text/markdown'
      }
    })
  })
})
