import { describe, expect, it } from 'vitest'
import { categorizeNativeChatTool, type NativeChatToolCategory } from './native-chat-tool-category'

describe('categorizeNativeChatTool', () => {
  const table: [string, NativeChatToolCategory][] = [
    // PascalCase (Anthropic/Claude)
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
    // lowercase (OpenAI/other tooling, fixture data)
    ['read', 'read'],
    ['edit', 'write'],
    ['write', 'write'],
    ['bash', 'exec'],
    ['glob', 'search']
  ]

  it.each(table)('classifies %s as %s', (name, category) => {
    expect(categorizeNativeChatTool(name)).toBe(category)
  })

  it('returns null for a clearly unrecognized name', () => {
    expect(categorizeNativeChatTool('SomeRandomTool')).toBeNull()
  })

  it('does not match on wrong case', () => {
    expect(categorizeNativeChatTool('webfetch')).toBeNull()
    expect(categorizeNativeChatTool('READ')).toBeNull()
    expect(categorizeNativeChatTool('BASH')).toBeNull()
    expect(categorizeNativeChatTool('EDIT')).toBeNull()
    expect(categorizeNativeChatTool('GLOB')).toBeNull()
  })

  it('does not match on prefix or substring', () => {
    expect(categorizeNativeChatTool('ReadFile')).toBeNull()
    expect(categorizeNativeChatTool('WriteBatch')).toBeNull()
    expect(categorizeNativeChatTool('BashTool')).toBeNull()
    expect(categorizeNativeChatTool('MultiEditor')).toBeNull()
    expect(categorizeNativeChatTool('WebSearchPlus')).toBeNull()
  })

  it('does not trim surrounding whitespace', () => {
    expect(categorizeNativeChatTool('Read ')).toBeNull()
    expect(categorizeNativeChatTool(' Read')).toBeNull()
  })

  it('returns null for the empty string', () => {
    expect(categorizeNativeChatTool('')).toBeNull()
  })

  it('does not special-case MCP-shaped names', () => {
    expect(categorizeNativeChatTool('mcp__server__tool')).toBeNull()
    expect(categorizeNativeChatTool('MCP')).toBeNull()
  })

  it('does not special-case the nameless-fallback placeholder', () => {
    expect(categorizeNativeChatTool('tool')).toBeNull()
  })
})
