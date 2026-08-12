export type PipelineDispatchDependency = { nodeId: string; result: string | null }

/**
 * T10: assembles the prompt actually sent to a node's agent at dispatch time.
 * With no dependencies the snapshot prompt passes through unchanged.
 */
export function assemblePipelineDispatchPrompt(args: {
  snapshotPrompt: string
  dependencies: PipelineDispatchDependency[]
}): string {
  if (args.dependencies.length === 0) {
    return args.snapshotPrompt
  }

  const sections = args.dependencies.map(
    (dependency) => `### Node "${dependency.nodeId}"\n${dependency.result ?? '(no result recorded)'}`
  )

  return `${args.snapshotPrompt}\n\n## Results of completed dependencies\n\n${sections.join('\n\n')}`
}
