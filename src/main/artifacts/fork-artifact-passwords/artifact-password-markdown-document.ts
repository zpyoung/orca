import { marked } from 'marked'

const MARKDOWN_STYLES = `
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { box-sizing: border-box; width: min(100% - 2rem, 52rem); margin: 0 auto; padding: 2.5rem 0 4rem; line-height: 1.65; }
h1, h2, h3, h4 { line-height: 1.25; margin-block: 1.5em 0.6em; }
h1 { font-size: 2rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.2rem; }
a { color: LinkText; } img { max-width: 100%; height: auto; }
pre, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
pre { overflow-x: auto; padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 0.5rem; }
code { font-size: 0.9em; } :not(pre) > code { padding: 0.12rem 0.3rem; border-radius: 0.25rem; background: color-mix(in srgb, CanvasText 8%, transparent); }
blockquote { margin-inline: 0; padding-left: 1rem; border-left: 0.2rem solid color-mix(in srgb, CanvasText 24%, transparent); }
table { width: 100%; border-collapse: collapse; } th, td { padding: 0.5rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); text-align: left; }
`

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Renders Markdown into the standalone HTML document encrypted for the recipient. */
export function renderProtectedArtifactMarkdown(markdown: string, title: string): string {
  const body = marked.parse(markdown, { async: false })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${MARKDOWN_STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`
}
