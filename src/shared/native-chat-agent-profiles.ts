import type { AgentType } from './agent-status-types'
import { getAgentSlashCommands, type SlashCommandSuggestion } from './native-chat-slash-commands'

export type NativeChatAgentProfile = {
  skillPrefix: '$' | '/'
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: AgentType
  /** Whether the TUI dispatches a plugin skill as `<plugin>:<skill>`. Only set
   *  where that syntax is verified — an unverified guess would insert a token
   *  the agent cannot resolve, so the rest fall back to the bare skill name. */
  namespacesPluginSkills: boolean
}

const NATIVE_CHAT_AGENT_PROFILES: Partial<Record<AgentType, NativeChatAgentProfile>> = {
  codex: {
    skillPrefix: '$',
    groupedSlash: false,
    skillSourceOwner: 'codex',
    namespacesPluginSkills: false
  },
  claude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude',
    namespacesPluginSkills: true
  },
  openclaude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude',
    namespacesPluginSkills: true
  },
  grok: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'grok',
    namespacesPluginSkills: false
  }
}

export function getNativeChatAgentProfile(
  agent: AgentType | null | undefined
): NativeChatAgentProfile | null {
  return agent ? (NATIVE_CHAT_AGENT_PROFILES[agent] ?? null) : null
}

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. Grok has no verified catalog yet, so its slash
 *  surface stays skills-only — this is the single place that policy lives. */
export function getVerifiedNativeChatCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return agent === 'grok' ? [] : getAgentSlashCommands(agent)
}

/** The mirror of the claimed set: catalog commands this agent acts on when they
 *  arrive as message text. The picker offers these too, so a command the agent
 *  implements is discoverable and not merely typable. */
export function getTextDrivenNativeChatCommands(
  agent: AgentType | null | undefined
): readonly SlashCommandSuggestion[] {
  if (!agent) {
    return []
  }
  const names = new Set(getNativeChatAgentProfile(agent)?.textDrivenCommands ?? [])
  return names.size === 0
    ? []
    : getVerifiedNativeChatCommands(agent).filter((command) => names.has(command.name))
}

/** Catalog commands the chat host answers itself. Whatever is left over reaches
 *  the agent as ordinary text, which is only correct where the agent implements
 *  the command — so an agent unclaims a command only via the profile above.
 *  Claiming stays the default: it is what stops a hand-typed `/clear` from being
 *  sent to the model as literal prompt text. */
export function getHostClaimedNativeChatCommands(
  agent: AgentType
): readonly SlashCommandSuggestion[] {
  const profile = getNativeChatAgentProfile(agent)
  if (profile?.expandsSlashCommandsFromText) {
    return []
  }
  const passedThrough = new Set(profile?.textDrivenCommands ?? [])
  return getVerifiedNativeChatCommands(agent).filter((command) => !passedThrough.has(command.name))
}
