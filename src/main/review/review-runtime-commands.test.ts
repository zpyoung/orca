import { describe, expect, it, vi } from 'vitest'
import { ReviewRuntimeCommands } from './review-runtime-commands'

const WSL_TARGET = {
  worktree: { id: 'repo::/workspace', path: '/workspace' },
  wslDistro: 'Ubuntu'
}

describe('ReviewRuntimeCommands', () => {
  it('refuses WSL instead of writing Linux paths through host Node fs', async () => {
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue(WSL_TARGET)
    const commands = new ReviewRuntimeCommands({ resolveRuntimeFileTarget })

    await expect(commands.runList('current')).rejects.toThrow(
      'Adversarial review run storage is not available for WSL workspaces (Ubuntu)'
    )
    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('current')
  })
})
