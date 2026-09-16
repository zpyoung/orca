import { win32 } from 'node:path'
import { objectivePathMatchesTerritory } from '../../shared/fork-heimdall-objective/plan-schema'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import { parseObjectiveDirtyPaths } from './content-identity'
import type { ObjectiveSnapshotBinding } from './execution-context'

export function objectiveDirtyPathsByTerritory(
  status: string,
  binding: ObjectiveSnapshotBinding
): { inside: string[]; outside: string[] } {
  const caseInsensitive =
    resolveLeasePathFlavor(binding.target.executionHostId, binding.target.workspacePath) === win32
  const territory = caseInsensitive
    ? binding.contract.writeTerritory.map((pattern) => pattern.toLowerCase())
    : binding.contract.writeTerritory
  const paths = [
    ...new Set(parseObjectiveDirtyPaths(status, caseInsensitive).entries.map((entry) => entry.path))
  ]
  const inside: string[] = []
  const outside: string[] = []
  for (const path of paths) {
    const candidate = caseInsensitive ? path.toLowerCase() : path
    ;(objectivePathMatchesTerritory(candidate, territory) ? inside : outside).push(path)
  }
  return { inside, outside }
}
