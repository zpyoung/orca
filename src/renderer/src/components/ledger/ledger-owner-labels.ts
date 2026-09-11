import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LedgerOwner } from '../../../../shared/ledger'
import type { Project, ProjectGroup } from '../../../../shared/types'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export type LedgerOwnerLabels = {
  /** The owner's display name, or `null` while it is unresolved or no longer in the catalog. */
  lookup: (owner: LedgerOwner | null | undefined) => string | null
  /** Re-reads the catalog so owners created since mount resolve to a name. */
  reload: () => void
}

function ownerKey(owner: Pick<LedgerOwner, 'tier' | 'id'>): string {
  return `${owner.tier}:${owner.id}`
}

export function buildLedgerOwnerLabels(
  projects: readonly Project[] = [],
  groups: readonly ProjectGroup[] = []
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const project of projects) {
    labels.set(ownerKey({ tier: 'project', id: project.id }), project.displayName)
  }
  for (const group of groups) {
    labels.set(ownerKey({ tier: 'group', id: group.id }), group.name)
  }
  return labels
}

/** Names every ledger owner in one runtime from a single catalog read; failures degrade to raw ids. */
export function useLedgerOwnerLabels(
  environmentId: string | undefined,
  enabled = true
): LedgerOwnerLabels {
  const [labels, setLabels] = useState<{ key: string; labels: Map<string, string> } | null>(null)
  const [generation, setGeneration] = useState(0)
  const key = environmentId ?? 'local'
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const target: RuntimeClientTarget = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
    // Why: one tier's catalog failing must not cost the other tier its names.
    void Promise.allSettled([
      callRuntimeRpc<{ projects: Project[] }>(target, 'project.list'),
      callRuntimeRpc<{ groups: ProjectGroup[] }>(target, 'projectGroup.list')
    ])
      .then(([projects, groups]) => {
        if (!cancelled) {
          setLabels({
            key,
            labels: buildLedgerOwnerLabels(
              projects.status === 'fulfilled' ? projects.value.projects : undefined,
              groups.status === 'fulfilled' ? groups.value.groups : undefined
            )
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled, environmentId, generation, key])
  const resolved = labels?.key === key ? labels.labels : null
  // Why: callers hold this in effect and callback dependency lists, so a new identity
  // per resolve would re-trigger their loads and never settle.
  const reload = useCallback(() => setGeneration((current) => current + 1), [])
  return useMemo(
    () => ({
      lookup: (owner) => (owner && resolved ? (resolved.get(ownerKey(owner)) ?? null) : null),
      reload
    }),
    [reload, resolved]
  )
}
