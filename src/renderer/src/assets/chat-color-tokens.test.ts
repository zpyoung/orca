import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')
const chatCodeColorsCss = fs.readFileSync(
  new URL('./native-chat-code-colors.css', import.meta.url),
  'utf8'
)

function getCssBlockBody(selector: string): string {
  const ruleMarker = mainCss.indexOf(`\n${selector} {`)
  expect(ruleMarker).toBeGreaterThanOrEqual(0)

  const ruleStart = ruleMarker + 1
  const bodyStart = mainCss.indexOf('{', ruleStart) + 1
  const bodyEnd = mainCss.indexOf('}', bodyStart)
  return mainCss.slice(bodyStart, bodyEnd)
}

const CODE_ACCENT_SURFACE_EXPR = 'color-mix(in srgb, var(--code-accent) 12%, var(--background))'
const CHAT_USER_SURFACE_EXPR = 'color-mix(in srgb, var(--tool-read) 13%, var(--background))'

const PALETTE_TOKENS: { name: string; light: string; dark: string }[] = [
  { name: '--tool-read', light: '#2f6a96', dark: '#8ab4d8' },
  { name: '--tool-write', light: '#8a6100', dark: '#e3b341' },
  { name: '--tool-exec', light: '#24707a', dark: '#79bfc4' },
  { name: '--tool-search', light: '#4f4fc4', dark: '#9a9ae6' },
  { name: '--tool-net', light: '#6a4fb0', dark: '#b39ddb' },
  { name: '--code-accent', light: '#a01e6a', dark: '#f191c5' },
  {
    name: '--code-accent-surface',
    light: CODE_ACCENT_SURFACE_EXPR,
    dark: CODE_ACCENT_SURFACE_EXPR
  },
  { name: '--chat-user-surface', light: CHAT_USER_SURFACE_EXPR, dark: CHAT_USER_SURFACE_EXPR }
]

const HLJS_TOKENS: { name: string; light: string; dark: string }[] = [
  { name: '--hljs-keyword', light: '#cf222e', dark: '#ff7b72' },
  { name: '--hljs-string', light: '#0a3069', dark: '#a5d6ff' },
  { name: '--hljs-number', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-comment', light: '#6e7781', dark: '#8b949e' },
  { name: '--hljs-function', light: '#8250df', dark: '#d2a8ff' },
  { name: '--hljs-title', light: '#8250df', dark: '#d2a8ff' },
  { name: '--hljs-built-in', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-type', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-attr', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-selector-class', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-variable', light: '#953800', dark: '#ffa657' },
  { name: '--hljs-meta', light: '#6e7781', dark: '#8b949e' },
  { name: '--hljs-tag', light: '#116329', dark: '#7ee787' },
  { name: '--hljs-name', light: '#116329', dark: '#7ee787' },
  { name: '--hljs-params', light: '#953800', dark: '#ffa657' },
  { name: '--hljs-literal', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-regexp', light: '#0a3069', dark: '#a5d6ff' },
  { name: '--hljs-operator', light: '#cf222e', dark: '#ff7b72' },
  { name: '--hljs-property', light: '#0550ae', dark: '#79c0ff' }
]

const ALL_TOKENS = [...PALETTE_TOKENS, ...HLJS_TOKENS]

// hljs-built_in is highlight.js's own class name; the token stays hyphenated like every other token.
const NATIVE_CHAT_CODE_CLASS_TO_TOKEN: { className: string; token: string }[] = [
  { className: 'hljs-keyword', token: '--hljs-keyword' },
  { className: 'hljs-string', token: '--hljs-string' },
  { className: 'hljs-number', token: '--hljs-number' },
  { className: 'hljs-comment', token: '--hljs-comment' },
  { className: 'hljs-function', token: '--hljs-function' },
  { className: 'hljs-title', token: '--hljs-title' },
  { className: 'hljs-built_in', token: '--hljs-built-in' },
  { className: 'hljs-type', token: '--hljs-type' },
  { className: 'hljs-attr', token: '--hljs-attr' },
  { className: 'hljs-selector-class', token: '--hljs-selector-class' },
  { className: 'hljs-variable', token: '--hljs-variable' },
  { className: 'hljs-meta', token: '--hljs-meta' },
  { className: 'hljs-tag', token: '--hljs-tag' },
  { className: 'hljs-name', token: '--hljs-name' },
  { className: 'hljs-params', token: '--hljs-params' },
  { className: 'hljs-literal', token: '--hljs-literal' },
  { className: 'hljs-regexp', token: '--hljs-regexp' },
  { className: 'hljs-operator', token: '--hljs-operator' },
  { className: 'hljs-property', token: '--hljs-property' }
]

describe('chat transcript color tokens', () => {
  it('imports the native chat code colors stylesheet', () => {
    expect(mainCss).toContain("@import './native-chat-code-colors.css';")
  })

  it('binds all 8 palette tokens through @theme inline', () => {
    const themeInline = getCssBlockBody('@theme inline')

    for (const token of PALETTE_TOKENS) {
      expect(themeInline).toContain(`--color-${token.name.slice(2)}: var(${token.name});`)
    }
  })

  it('never binds an hljs token through @theme inline', () => {
    const themeInline = getCssBlockBody('@theme inline')

    expect(themeInline).not.toContain('hljs')
  })

  it.each(ALL_TOKENS)('declares $name in :root (light) and .dark with locked values', (token) => {
    const root = getCssBlockBody(':root')
    const dark = getCssBlockBody('.dark')

    expect(root).toContain(`${token.name}: ${token.light};`)
    expect(dark).toContain(`${token.name}: ${token.dark};`)
  })

  it('declares --code-accent-surface and --chat-user-surface as color-mix expressions in both themes', () => {
    const root = getCssBlockBody(':root')
    const dark = getCssBlockBody('.dark')

    for (const block of [root, dark]) {
      expect(block).toContain(`--code-accent-surface: ${CODE_ACCENT_SURFACE_EXPR};`)
      expect(block).toContain(`--chat-user-surface: ${CHAT_USER_SURFACE_EXPR};`)
    }
  })

  it('does not add any of the 27 new tokens to .plugin-security-chrome', () => {
    const pluginSecurityChrome = getCssBlockBody('.plugin-security-chrome')

    for (const token of ALL_TOKENS) {
      expect(pluginSecurityChrome).not.toContain(token.name)
    }
  })
})

describe('native chat code colors stylesheet', () => {
  it('defines all 19 .native-chat-code .hljs-* rules against the matching token', () => {
    for (const { className, token } of NATIVE_CHAT_CODE_CLASS_TO_TOKEN) {
      const marker = `.native-chat-code .${className} {`
      const start = chatCodeColorsCss.indexOf(marker)
      expect(start).toBeGreaterThanOrEqual(0)

      const bodyStart = chatCodeColorsCss.indexOf('{', start) + 1
      const bodyEnd = chatCodeColorsCss.indexOf('}', bodyStart)
      const body = chatCodeColorsCss.slice(bodyStart, bodyEnd)

      expect(body).toContain(`color: var(${token});`)
    }
  })

  it('gives .native-chat-code .hljs-comment an italic style, matching the editor', () => {
    const start = chatCodeColorsCss.indexOf('.native-chat-code .hljs-comment {')
    const bodyStart = chatCodeColorsCss.indexOf('{', start) + 1
    const bodyEnd = chatCodeColorsCss.indexOf('}', bodyStart)
    const body = chatCodeColorsCss.slice(bodyStart, bodyEnd)

    expect(body).toContain('font-style: italic;')
  })

  it('contains no literal hex color value', () => {
    expect(chatCodeColorsCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
