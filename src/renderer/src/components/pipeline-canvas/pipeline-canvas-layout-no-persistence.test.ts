import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The two modules that compute node positions. Neither should ever reach a persistence API —
// layout is derived fresh from topology on every render (AC21) and nothing about it is saved.
const LAYOUT_FILES = ['pipeline-canvas-layout.ts', 'PipelineCanvasScene.tsx']

const PERSISTENCE_TOKENS = [
  'localStorage',
  'sessionStorage',
  'useAppStore',
  'electron-store',
  'ipcRenderer.invoke',
  'persist('
]

describe('pipeline canvas layout — no persistence (AC21)', () => {
  it.each(LAYOUT_FILES)('%s never references a persistence API', (filename) => {
    const source = readFileSync(join(__dirname, filename), 'utf8')
    for (const token of PERSISTENCE_TOKENS) {
      expect(source).not.toContain(token)
    }
  })
})
