import { describe, expect, it } from 'vitest'
import {
  HEIMDALL_PIPELINE_CLIENT_CAPABILITIES,
  HEIMDALL_PIPELINE_NODE_CAPABILITY,
  HEIMDALL_PIPELINE_RUNTIME_CAPABILITIES,
  HEIMDALL_PIPELINE_RUNTIME_CAPABILITY,
  hostPipelineNodeTypes
} from './capability'

describe('pipeline wire capabilities', () => {
  it('advertises the runtime and one capability for each node type', () => {
    expect(HEIMDALL_PIPELINE_NODE_CAPABILITY('swarm')).toBe('heimdall.pipeline-node.swarm.v1')
    expect(HEIMDALL_PIPELINE_RUNTIME_CAPABILITIES).toHaveLength(12)
    expect(HEIMDALL_PIPELINE_RUNTIME_CAPABILITIES[0]).toBe('heimdall.pipeline.v1')
    expect(HEIMDALL_PIPELINE_RUNTIME_CAPABILITY).toBe('heimdall.pipeline.v1')
    expect(HEIMDALL_PIPELINE_CLIENT_CAPABILITIES).toEqual(['heimdall.pipeline.v1'])
  })

  it('maps advertised node capabilities back to only their node types', () => {
    expect(
      hostPipelineNodeTypes(['heimdall.pipeline.v1', 'heimdall.pipeline-node.agent.v1', 'x'])
    ).toEqual(new Set(['agent']))
  })
})
