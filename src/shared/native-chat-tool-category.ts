/**
 * Semantic grouping for a native chat agent tool, used to pick a transcript
 * color and glyph. `read`/`write` cover file inspection and mutation,
 * `exec` covers shell/process execution, `search` covers pattern lookup,
 * and `net` covers outbound web requests.
 */
export type NativeChatToolCategory = 'read' | 'write' | 'exec' | 'search' | 'net'

// a Map avoids prototype-chain lookups (e.g. name === 'constructor') that a plain object would leak through
const TOOL_CATEGORY_BY_NAME: ReadonlyMap<string, NativeChatToolCategory> = new Map([
  // PascalCase names (Anthropic/Claude tooling)
  ['Read', 'read'],
  ['NotebookRead', 'read'],
  ['Edit', 'write'],
  ['MultiEdit', 'write'],
  ['Write', 'write'],
  ['str_replace', 'write'],
  ['apply_patch', 'write'],
  ['Bash', 'exec'],
  ['terminal', 'exec'],
  ['shell', 'exec'],
  ['Grep', 'search'],
  ['Glob', 'search'],
  ['grep', 'search'],
  ['WebFetch', 'net'],
  ['WebSearch', 'net'],
  // lowercase names (OpenAI/other tooling, fixture data)
  ['read', 'read'],
  ['edit', 'write'],
  ['write', 'write'],
  ['bash', 'exec'],
  ['glob', 'search']
])

/**
 * Classifies a `NativeChatToolCallBlock.name` into its semantic category via
 * an exact, case-sensitive match against known agent tool names. An
 * unrecognized name — including third-party or MCP tool names this app does
 * not control — returns `null` by design, so the renderer draws it unchanged
 * rather than asserting a category it can't back up.
 */
export function categorizeNativeChatTool(name: string): NativeChatToolCategory | null {
  return TOOL_CATEGORY_BY_NAME.get(name) ?? null
}
