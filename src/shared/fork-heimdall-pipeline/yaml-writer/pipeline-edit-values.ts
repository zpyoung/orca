export type PipelineScalarValue = string | number | boolean | null

/** Narrow YAML-compatible primitive values for scalar token replacement. */
export function isPipelineScalarValue(value: unknown): value is PipelineScalarValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/** Read an own field by name from a schema object or YAML record. */
export function pipelineObjectProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

/** Compare schema values without depending on object-property insertion order. */
export function arePipelineEditValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => arePipelineEditValuesEqual(value, right[index]))
    )
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        arePipelineEditValuesEqual(
          pipelineObjectProperty(left, key),
          pipelineObjectProperty(right, key)
        )
    )
  )
}

/** Remove JavaScript-only `undefined` values before comparing or serializing YAML data. */
export function cleanPipelineYamlValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanPipelineYamlValue)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const cleaned: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) {
      cleaned[key] = cleanPipelineYamlValue(child)
    }
  }
  return cleaned
}
