import { useEffect, useState } from 'react'
import type { LedgerOwner } from '../../../../shared/ledger'
import type { Project, ProjectGroup } from '../../../../shared/types'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export function useLedgerOwnerName(
  owner: LedgerOwner | null,
  environmentId: string | undefined,
  isVisible: boolean
): string | null {
  const tier = owner?.tier
  const id = owner?.id
  const key = JSON.stringify([environmentId, tier, id])
  const [resolved, setResolved] = useState<{ key: string; name: string } | null>(null)
  useEffect(() => {
    if (!isVisible || !tier || !id) {
      return
    }
    let cancelled = false
    const target: RuntimeClientTarget = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
    const lookup =
      tier === 'project'
        ? callRuntimeRpc<{ projects: Project[] }>(target, 'project.list').then(
            (result) => result.projects.find((project) => project.id === id)?.displayName
          )
        : callRuntimeRpc<{ groups: ProjectGroup[] }>(target, 'projectGroup.list').then(
            (result) => result.groups.find((group) => group.id === id)?.name
          )
    void lookup
      .then((name) => {
        if (!cancelled && name) {
          setResolved({ key, name })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [environmentId, id, isVisible, key, tier])
  return resolved?.key === key ? resolved.name : null
}
