import { useEffect, useRef } from 'react'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../../../shared/ai-vault-types'

type VaultNavigationRequest = {
  sessionId: string
  agent?: string
}

type VaultNavigationListener = (request: VaultNavigationRequest) => void

let pendingRequest: VaultNavigationRequest | null = null
const listeners = new Set<VaultNavigationListener>()

function asVaultAgent(agent: string | undefined): AiVaultAgent | null {
  return AI_VAULT_AGENTS.find((candidate) => candidate === agent) ?? null
}

/** Queue exact-session Vault navigation across the lazy panel mount boundary. */
export function requestSessionInfoVaultNavigation(request: VaultNavigationRequest): void {
  pendingRequest = listeners.size === 0 ? request : null
  for (const listener of listeners) {
    listener(request)
  }
}

/** Apply queued Session Info navigation when the lazy Vault panel is ready. */
export function useSessionInfoVaultNavigation(
  setQuery: (query: string) => void,
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
): void {
  const applyRef = useRef<VaultNavigationListener>(() => undefined)
  applyRef.current = (request) => {
    setQuery(request.sessionId)
    const agent = asVaultAgent(request.agent)
    if (agent) {
      setAgentEnabled(agent, true)
    }
  }

  useEffect(() => {
    const listener: VaultNavigationListener = (request) => applyRef.current(request)
    listeners.add(listener)
    if (pendingRequest) {
      listener(pendingRequest)
      pendingRequest = null
    }
    return () => {
      listeners.delete(listener)
    }
  }, [])
}
