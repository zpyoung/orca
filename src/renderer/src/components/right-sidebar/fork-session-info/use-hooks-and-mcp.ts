import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { loadMcpConfigInspections } from '@/components/settings/mcp-config-inspection'
import type {
  SessionInfoHooksAndMcp,
  SessionInfoStatusLineChainStatus
} from '../../../../../shared/fork-session-info/session-info-types'
import type { McpConfigInspection, McpServerSummary } from '../../../../../shared/mcp-config'
import { getForkSessionInfoApi } from './session-info-renderer-api'

export type HooksAndMcpLoadState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value?: SessionInfoHooksAndMcp
  error?: string
  enablingStatusLine: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Flatten every config scope's servers, keeping the first scope that defines each name. */
function dedupeServersByName(inspections: McpConfigInspection[]): McpServerSummary[] {
  const byName = new Map<string, McpServerSummary>()
  for (const inspection of inspections) {
    for (const server of inspection.servers) {
      if (!byName.has(server.name)) {
        byName.set(server.name, server)
      }
    }
  }
  return [...byName.values()]
}

/** Return whether the focused session owns Claude's local statusline capability. */
export function canInspectClaudeStatusLine(
  agentType: string | undefined,
  isLocalExecution: boolean
): boolean {
  return agentType === 'claude' && isLocalExecution
}

export function useHooksAndMcp({
  bindingKey,
  agentType,
  workspaceRoot,
  connectionId,
  isLocalExecution,
  canInspectMcp
}: {
  bindingKey: string
  agentType: string | undefined
  workspaceRoot: string | null
  connectionId: string | undefined
  isLocalExecution: boolean
  canInspectMcp: boolean
}): HooksAndMcpLoadState & { load: () => void; enableStatusLine: () => void } {
  const [state, setState] = useState<HooksAndMcpLoadState>({
    status: 'idle',
    enablingStatusLine: false
  })
  const generation = useRef(0)

  useLayoutEffect(() => {
    generation.current += 1
    setState({ status: 'idle', enablingStatusLine: false })
  }, [bindingKey])

  const load = useCallback(() => {
    const requestGeneration = ++generation.current
    setState({ status: 'loading', enablingStatusLine: false })
    const api = getForkSessionInfoApi()
    const hookRequest =
      agentType === 'claude' && isLocalExecution
        ? window.api.agentHooks.claudeStatus()
        : Promise.resolve(undefined)
    const mcpRequest =
      workspaceRoot && canInspectMcp
        ? loadMcpConfigInspections(workspaceRoot, connectionId)
        : Promise.resolve([])
    const statusLineRequest =
      api && canInspectClaudeStatusLine(agentType, isLocalExecution)
        ? api.getStatusLineChainStatus()
        : Promise.resolve<SessionInfoStatusLineChainStatus | undefined>(undefined)

    void Promise.allSettled([hookRequest, mcpRequest, statusLineRequest] as const).then(
      (results) => {
        if (requestGeneration !== generation.current) {
          return
        }
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => errorMessage(result.reason))
        const hookStatus = results[0].status === 'fulfilled' ? results[0].value : undefined
        const inspections =
          results[1].status === 'fulfilled' && workspaceRoot && canInspectMcp
            ? results[1].value
            : undefined
        const statusLine = results[2].status === 'fulfilled' ? results[2].value : undefined
        setState({
          status: errors.length > 0 ? 'error' : 'ready',
          value: {
            hookStatus,
            statusLine,
            ...(inspections ? { mcpServers: dedupeServersByName(inspections) } : {}),
            updatedAt: Date.now()
          },
          error: errors.length > 0 ? errors.join(' · ') : undefined,
          enablingStatusLine: false
        })
      }
    )
  }, [agentType, canInspectMcp, connectionId, isLocalExecution, workspaceRoot])

  const enableStatusLine = useCallback(() => {
    const api = getForkSessionInfoApi()
    if (!api || !canInspectClaudeStatusLine(agentType, isLocalExecution)) {
      return
    }
    const requestGeneration = generation.current
    setState((current) => ({ ...current, enablingStatusLine: true }))
    void api
      .enableStatusLineChaining()
      .then((statusLine) => {
        if (requestGeneration !== generation.current) {
          return
        }
        setState((current) => ({
          ...current,
          status: 'ready',
          value: current.value
            ? { ...current.value, statusLine, updatedAt: Date.now() }
            : { statusLine, updatedAt: Date.now() },
          error: undefined,
          enablingStatusLine: false
        }))
      })
      .catch((error) => {
        if (requestGeneration !== generation.current) {
          return
        }
        setState((current) => ({
          ...current,
          status: 'error',
          error: errorMessage(error),
          enablingStatusLine: false
        }))
      })
  }, [agentType, isLocalExecution])

  return { ...state, load, enableStatusLine }
}
