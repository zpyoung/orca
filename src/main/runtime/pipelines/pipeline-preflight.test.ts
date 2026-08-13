import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedPipelineNode } from '../../../shared/pipeline-template'
import type { TuiAgent } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'

const isCommandOnPathMock = vi.fn()
const detectCommandsInInstallDirsMock = vi.fn()
const detectWslCommandsOnPathMock = vi.fn()
const getActiveMultiplexerMock = vi.fn()

vi.mock('../../ipc/preflight-command-exec', () => ({
  isCommandOnPath: isCommandOnPathMock
}))
vi.mock('../../ipc/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsInInstallDirsMock
}))
vi.mock('../../ipc/preflight-wsl-agent-detection', () => ({
  detectWslCommandsOnPath: detectWslCommandsOnPathMock
}))
vi.mock('../../ipc/ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

const { validatePipelineNodeLaunch } = await import('./pipeline-preflight')

function node(overrides: Partial<ResolvedPipelineNode> = {}): ResolvedPipelineNode {
  return {
    id: 'build',
    title: 'Build',
    prompt: 'do the thing',
    index: 0,
    needs: [],
    harness: 'claude',
    ...overrides
  }
}

function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}) {
  return {
    validateOrchestrationAgentLauncher: vi.fn(),
    getClientSettings: vi.fn().mockReturnValue({ agentCmdOverrides: {} }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('validatePipelineNodeLaunch', () => {
  beforeEach(() => {
    isCommandOnPathMock.mockReset().mockResolvedValue(true)
    detectCommandsInInstallDirsMock.mockReset().mockReturnValue(new Set())
    detectWslCommandsOnPathMock.mockReset().mockResolvedValue(new Set())
    getActiveMultiplexerMock.mockReset()
  })

  it('(a) refuses an unknown harness identifier, naming the node and field', async () => {
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({
      runtime,
      node: node({ harness: 'not-a-real-agent' }),
      host: {}
    })
    expect(result).toEqual({
      ok: false,
      nodeId: 'build',
      field: 'harness',
      message: expect.stringContaining('not-a-real-agent')
    })
  })

  it('narrows harness to TuiAgent on success', async () => {
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({ runtime, node: node(), host: {} })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.agent satisfies TuiAgent).toBe('claude')
    }
  })

  it('(b) refuses a disabled agent, naming the node and field', async () => {
    const runtime = runtimeStub({
      validateOrchestrationAgentLauncher: vi.fn(() => {
        throw new Error('Agent launcher claude is disabled or unavailable.')
      })
    })
    const result = await validatePipelineNodeLaunch({ runtime, node: node(), host: {} })
    expect(result).toEqual({
      ok: false,
      nodeId: 'build',
      field: 'harness',
      message: 'Agent launcher claude is disabled or unavailable.'
    })
  })

  it('(c) refuses a catalog-rejected model, naming the node and field "model"', async () => {
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({
      runtime,
      node: node({ harness: 'grok', model: 'grok-code-fast-1' }),
      host: {}
    })
    expect(result).toEqual({
      ok: false,
      nodeId: 'build',
      field: 'model',
      message: expect.stringContaining('does not support launch-time model selection')
    })
  })

  it('(c) refuses a catalog-rejected effort, naming the node and field "effort"', async () => {
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({
      runtime,
      node: node({ harness: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' }),
      host: {}
    })
    expect(result).toEqual({
      ok: false,
      nodeId: 'build',
      field: 'effort',
      message: expect.stringContaining('does not support effort xhigh')
    })
  })

  it('(c) refuses an effort set without a model, naming the field "effort"', async () => {
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({
      runtime,
      node: node({ harness: 'codex', effort: 'high' }),
      host: {}
    })
    expect(result).toEqual({
      ok: false,
      nodeId: 'build',
      field: 'effort',
      message: expect.stringContaining('--effort requires --model')
    })
  })

  it('(d) refuses when the effective launch command does not resolve on the host', async () => {
    isCommandOnPathMock.mockResolvedValue(false)
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({ runtime, node: node(), host: {} })
    expect(result).toEqual({
      ok: false,
      nodeId: 'build',
      field: 'harness',
      message: expect.stringContaining('claude')
    })
  })

  it('(d) reports a distinct message on an SSH detection transport failure, not a throw', async () => {
    getActiveMultiplexerMock.mockReturnValue(undefined)
    const runtime = runtimeStub()
    const result = await validatePipelineNodeLaunch({
      runtime,
      node: node(),
      host: { connectionId: 'ssh-1' }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.field).toBe('harness')
      expect(result.message).toMatch(/could not verify/i)
      expect(result.message).not.toMatch(/not found/i)
    }
  })

  it('override coverage: a present-but-nonstandard override command passes preflight', async () => {
    isCommandOnPathMock.mockImplementation(async (cmd: string) => cmd === '/opt/custom/claude-cli')
    const runtime = runtimeStub({
      getClientSettings: vi
        .fn()
        .mockReturnValue({ agentCmdOverrides: { claude: '/opt/custom/claude-cli' } })
    })
    const result = await validatePipelineNodeLaunch({ runtime, node: node(), host: {} })
    expect(result).toEqual({ ok: true, agent: 'claude' })
  })

  it('override coverage: a missing override command refuses even though the catalog default exists', async () => {
    isCommandOnPathMock.mockImplementation(async (cmd: string) => cmd === 'claude')
    const runtime = runtimeStub({
      getClientSettings: vi
        .fn()
        .mockReturnValue({ agentCmdOverrides: { claude: '/opt/missing/claude-cli' } })
    })
    const result = await validatePipelineNodeLaunch({ runtime, node: node(), host: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('/opt/missing/claude-cli')
    }
  })
})
