import {
  PipelineLayoutWriteSchema,
  type PipelineLayout,
  type PipelineLayoutWrite
} from '../layout-schema'

/** Serialize layout state deterministically in pipeline-node order. */
export function renderPipelineLayout(layout: PipelineLayout, nodeOrder: readonly string[]): string {
  const parsed = PipelineLayoutWriteSchema.parse(layout)
  const nodes: PipelineLayoutWrite['nodes'] = {}
  const seen = new Set<string>()
  for (const id of nodeOrder) {
    const point = parsed.nodes[id]
    if (point !== undefined && !seen.has(id)) {
      nodes[id] = point
      seen.add(id)
    }
  }
  const ordered: PipelineLayoutWrite = {
    version: parsed.version,
    nodes,
    ...(parsed.viewport === undefined ? {} : { viewport: parsed.viewport })
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}
