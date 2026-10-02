import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineAgentNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import { issuePipelineReportPath } from './pipeline-report-path'
import { readPipelineReport, validatePipelineReport } from './pipeline-report-ingestion'

const directories: string[] = []

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'pipeline-report-'))
  directories.push(workspace)
  return workspace
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function agentNode(outputs: NonNullable<PipelineAgentNode['outputs']>): PipelineAgentNode {
  return { id: 'implement', type: 'agent', prompt: 'Implement', outputs }
}

async function fileExists(workspace: string, relativePath: string): Promise<boolean> {
  try {
    await stat(join(workspace, relativePath))
    return true
  } catch {
    return false
  }
}

describe('validatePipelineReport', () => {
  it('accepts every declared output type when values satisfy the report contract', async () => {
    const workspace = await createWorkspace()
    await writeFile(join(workspace, 'artifact.md'), 'finished')
    const node = agentNode({
      text: { type: 'text' },
      count: { type: 'number' },
      ready: { type: 'boolean' },
      metadata: { type: 'json' },
      artifact: { type: 'file' },
      tasks: { type: 'taskList' },
      verdict: { type: 'verdict' },
      status: { type: 'enum', values: ['done', 'blocked'] }
    })
    const result = await validatePipelineReport(
      {
        nodeId: 'implement',
        summary: 'Implemented the feature',
        outputs: {
          text: 'complete',
          count: 3,
          ready: true,
          metadata: { nested: [null, 'value', 3] },
          artifact: 'artifact.md',
          tasks: [{ id: 'task-1', title: 'Verify', spec: 'Run the focused scenario.' }],
          verdict: { verdict: 'approve', reason: 'Checks passed', objections: [] },
          status: 'done'
        }
      },
      node,
      (relativePath) => fileExists(workspace, relativePath)
    )

    expect(result).toMatchObject({ ok: true })
  })

  it('rejects extra and missing outputs by their declared names', async () => {
    const node = agentNode({ summary: { type: 'text' } })
    const extra = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { summary: 'ok', surprise: 1 } },
      node,
      async () => false
    )
    const missing = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: {} },
      node,
      async () => false
    )

    expect(extra).toMatchObject({ ok: false, error: expect.stringContaining('surprise') })
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('summary') })
  })
  it('rejects inherited output names but accepts explicitly declared prototype-looking keys', async () => {
    const undeclaredNode = agentNode({})
    const constructor = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { constructor: 'value' } },
      undeclaredNode,
      async () => false
    )
    const toString = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { toString: 'value' } },
      undeclaredNode,
      async () => false
    )
    const declaredOutputs = {
      constructor: { type: 'text' as const }
    } satisfies NonNullable<PipelineAgentNode['outputs']>
    const declaredConstructor = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { constructor: 'valid' } },
      agentNode(declaredOutputs),
      async () => false
    )

    expect(constructor).toMatchObject({
      ok: false,
      error: expect.stringContaining('constructor')
    })
    expect(toString).toMatchObject({ ok: false, error: expect.stringContaining('toString') })
    expect(declaredConstructor).toMatchObject({ ok: true })
  })

  it('rejects missing files and paths that escape the reporting workspace', async () => {
    const node = agentNode({ artifact: { type: 'file' } })
    const missingFile = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { artifact: 'missing.md' } },
      node,
      async () => false
    )
    const unsafeFile = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { artifact: '../outside.md' } },
      node,
      async () => true
    )

    expect(missingFile).toMatchObject({ ok: false, error: expect.stringContaining('missing.md') })
    expect(unsafeFile).toMatchObject({
      ok: false,
      error: expect.stringContaining('worktree-relative')
    })
  })

  it('rejects malformed task lists and values outside enum and verdict schemas', async () => {
    const taskList = await validatePipelineReport(
      {
        nodeId: 'implement',
        summary: 'done',
        outputs: { tasks: [{ id: 'task-1', title: 1, spec: 'work' }] }
      },
      agentNode({ tasks: { type: 'taskList' } }),
      async () => false
    )
    const enumValue = await validatePipelineReport(
      { nodeId: 'implement', summary: 'done', outputs: { status: 'other' } },
      agentNode({ status: { type: 'enum', values: ['done', 'blocked'] } }),
      async () => false
    )
    const verdict = await validatePipelineReport(
      {
        nodeId: 'implement',
        summary: 'done',
        outputs: { verdict: { verdict: 'approve', extra: true } }
      },
      agentNode({ verdict: { type: 'verdict' } }),
      async () => false
    )

    expect(taskList).toMatchObject({ ok: false, error: expect.stringContaining('title') })
    expect(enumValue).toMatchObject({ ok: false, error: expect.stringContaining('done') })
    expect(verdict).toMatchObject({ ok: false, error: expect.stringContaining('extra') })
  })

  it('enforces the node id and summary length', async () => {
    const node = agentNode({})
    const wrongNode = await validatePipelineReport(
      { nodeId: 'different', summary: 'done', outputs: {} },
      node,
      async () => false
    )
    const longSummary = await validatePipelineReport(
      { nodeId: 'implement', summary: 'x'.repeat(4_001), outputs: {} },
      node,
      async () => false
    )

    expect(wrongNode).toMatchObject({ ok: false, error: expect.stringContaining('implement') })
    expect(longSummary).toMatchObject({ ok: false })
  })
})

describe('readPipelineReport', () => {
  it('classifies a report over the hardened 256 KiB byte cap as unverifiable', async () => {
    const workspacePath = await createWorkspace()
    const target = {
      executionHostId: 'local' as const,
      workspaceKind: 'folder' as const,
      workspacePath,
      attemptFingerprint: 'attempt-fingerprint'
    }
    const reportPath = issuePipelineReportPath(target, target.attemptFingerprint)
    await mkdir(join(workspacePath, '.orca', 'heimdall', 'pipeline', 'reports'), {
      recursive: true
    })
    await writeFile(reportPath, Buffer.alloc(256 * 1024 + 1, 0x61))

    await expect(readPipelineReport(reportPath, target)).resolves.toEqual({
      status: 'unverifiable',
      reason: 'oversize'
    })
  })
})
