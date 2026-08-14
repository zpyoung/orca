import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const JS_FENCE = '```js\nconst x = 1;\n```'
const MERMAID_FENCE = '```mermaid\ngraph TD; A-->B;\n```'

describe('CommentMarkdown highlightCode flag', () => {
  it('renders code without hljs classes when the flag is absent and onLinkClick is provided', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        content={`${JS_FENCE}\n\n\`inline\``}
        onLinkClick={() => {}}
      />
    )

    expect(markup).not.toContain('hljs')
    expect(markup).toContain('bg-accent')
  })

  it('renders code without hljs classes when the flag is absent and onLinkClick is omitted', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown variant="document" content={`${JS_FENCE}\n\n\`inline\``} />
    )

    expect(markup).not.toContain('hljs')
    expect(markup).toContain('bg-accent')
  })

  it('highlights fenced code with hljs classes when the flag is true and onLinkClick is provided', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown variant="document" content={JS_FENCE} onLinkClick={() => {}} highlightCode />
    )

    expect(markup).toContain('hljs-')
    expect(markup).toContain('bg-code-accent-surface')
    expect(markup).toContain('text-code-accent')
  })

  // Regression guard for the module-level singleton bug: chat's
  // useNativeChatFileLinkClick returns undefined whenever its context is
  // null, so highlightCode must not silently fall back to the pre-built
  // zero-argument singleton when onLinkClick is falsy. rehype-highlight runs
  // at the AST level regardless of which component renderer is picked, so the
  // accent classes on <code> (not the hljs- spans alone) are what the
  // singleton bug actually breaks.
  it('highlights fenced code with hljs classes and the code accent when the flag is true and onLinkClick is explicitly undefined', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown
        variant="document"
        content={JS_FENCE}
        onLinkClick={undefined}
        highlightCode
      />
    )

    expect(markup).toContain('hljs-')
    expect(markup).toContain('bg-code-accent-surface')
    expect(markup).toContain('text-code-accent')
  })

  it('applies the code accent classes and wrapper reset when the flag is true', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown variant="document" content="`inline`" highlightCode />
    )

    expect(markup).toContain('bg-code-accent-surface')
    expect(markup).toContain('text-code-accent')
    expect(markup).toContain('native-chat-code')
    expect(markup).toContain('[&amp;_pre_code]:text-inherit')
  })

  it('still routes mermaid fences through the mermaid renderer when the flag is true', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown variant="document" content={MERMAID_FENCE} highlightCode />
    )

    expect(markup).toContain('mermaid-block')
    expect(markup).not.toContain('<pre')
    expect(markup).not.toContain('hljs-')
  })
})
