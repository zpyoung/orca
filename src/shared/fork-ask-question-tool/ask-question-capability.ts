// Why: client → host capability, sent in clientCapabilities (not RUNTIME_CAPABILITIES) — it
// tells the host this connection owns a surface capable of docking an ask card.
export const ASK_SURFACE_CLIENT_CAPABILITY = 'ask.surface.v1' as const
export const ASK_REGISTRY_RUNTIME_CAPABILITY = 'ask.registry.v1' as const
