// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerEntry, LedgerRequest, LedgerResponse } from '../../../../shared/ledger'
import type { LedgerEntryFormProps } from '../ledger/LedgerEntryForm'
import type { LedgerEntryDetailProps } from '../ledger/LedgerEntryDetail'
import type { LedgerTriagePanelProps } from '../ledger/LedgerTriagePanel'

const mocks = vi.hoisted(() => ({
  store: {
    activeWorktreeId: 'worktree-a' as string | null,
    activeWorkspaceKey: null as string | null,
    folderWorkspaces: [] as { id: string; name: string; projectGroupId?: string }[],
    repos: [] as { id: string; projectGroupId?: string }[],
    getKnownWorktreeById: (id: string) => ({ id, repoId: 'repo-a', displayName: 'Worktree A' }),
    ledgerEntries: ['full-page-entry'],
    ledgerSummary: { ledgerId: 'full-page' },
    loadLedger: vi.fn()
  },
  environmentId: undefined as string | undefined,
  request: vi.fn(),
  catalog: vi.fn(),
  form: null as LedgerEntryFormProps | null,
  detail: null as LedgerEntryDetailProps | null,
  triage: null as LedgerTriagePanelProps | null,
  runtimeSettings: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.catalog(...args)
}))
vi.mock('@/runtime/runtime-ledger-client', () => ({
  requestLedger: (...args: unknown[]) => mocks.request(...args)
}))
vi.mock('./file-explorer-runtime-owner', () => ({
  getRightSidebarWorktreeRuntimeSettings: (id: string) => {
    mocks.runtimeSettings(id)
    return { activeRuntimeEnvironmentId: mocks.environmentId }
  }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange
  }: {
    children: React.ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  DropdownMenuRadioItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  )
}))
vi.mock('../ledger/LedgerEntryForm', () => ({
  LedgerEntryForm: (props: LedgerEntryFormProps) => {
    mocks.form = props
    return props.open ? <div data-dialog="form" /> : null
  }
}))
vi.mock('../ledger/LedgerEntryDetail', () => ({
  LedgerEntryDetail: (props: LedgerEntryDetailProps) => {
    mocks.detail = props
    return props.entry ? <div data-dialog="detail" /> : null
  }
}))
vi.mock('../ledger/LedgerTriagePanel', () => ({
  LedgerTriagePanel: (props: LedgerTriagePanelProps) => {
    mocks.triage = props
    return props.open ? <div data-dialog="triage" /> : null
  }
}))
import LedgerPanel from './LedgerPanel'

const entry: LedgerEntry = {
  id: 'BUG-1',
  type: 'bug',
  sequence: 1,
  revision: 1,
  content: { title: 'Panel entry' },
  state: 'open',
  reviewed: false,
  origin: { workspaceId: 'worktree-a' },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  history: [],
  latestContentActor: { kind: 'human', model: null, providerSessionId: null }
}
const response = (): LedgerResponse => ({
  schemaVersion: 1,
  runtime: { runtimeId: 'runtime', profileId: 'profile' },
  entries: [entry],
  ledger: {
    ledgerId: 'panel-ledger',
    tier: 'group',
    owner: { tier: 'group', id: 'actual-group' },
    formerOwner: null,
    runtime: { runtimeId: 'runtime', profileId: 'profile' },
    revision: 1,
    entryCount: 1,
    nextSequence: 2,
    staleAfterDays: 30,
    sourceEquivalences: []
  }
})
let container: HTMLDivElement
let root: Root
async function render(isVisible = true) {
  await act(async () => {
    root.render(<LedgerPanel isVisible={isVisible} />)
  })
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.activeWorktreeId = 'worktree-a'
  mocks.store.activeWorkspaceKey = null
  mocks.store.repos = [{ id: 'repo-a', projectGroupId: 'group-a' }]
  mocks.store.folderWorkspaces = [{ id: 'folder-a', name: 'Folder A', projectGroupId: 'group-a' }]
  mocks.environmentId = undefined
  mocks.request.mockResolvedValue(response())
  mocks.catalog.mockResolvedValue({ groups: [], projects: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('LedgerPanel', () => {
  it('does not query without a workspace', async () => {
    mocks.store.activeWorktreeId = null
    await render()
    expect(container.textContent).toContain('Open a workspace to see its ledger.')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('routes folder keys verbatim and marks raw folder origins', async () => {
    mocks.store.activeWorktreeId = null
    mocks.store.activeWorkspaceKey = 'folder:folder-a'
    mocks.request.mockResolvedValue({
      ...response(),
      entries: [{ ...entry, origin: { workspaceId: 'folder-a' } }]
    })
    await render()
    expect(mocks.request).toHaveBeenCalledWith(
      {
        operation: 'list',
        target: { workspaceId: 'folder:folder-a' },
        filters: { workspaceId: 'folder:folder-a' }
      },
      undefined
    )
    await click('Group')
    expect(container.textContent).toContain('Filed here')
  })
  it('offers creation without guessing an owner for an uncreated ledger', async () => {
    mocks.request.mockResolvedValue({ ...response(), ledger: null, entries: [] })
    await render()
    expect(container.textContent).not.toContain('Group ·')
    await click('New entry')
    expect(container.querySelector('[data-dialog="form"]')).not.toBeNull()
  })
  it.each([
    ['owner-ambiguous', 'single project'],
    ['group-missing', 'has no group'],
    ['workspace-missing', 'not live'],
    ['owner-missing', 'no longer exists']
  ])('shows actionable scope failure %s', async (code, message) => {
    mocks.request.mockRejectedValue(Object.assign(new Error('server error'), { code }))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message)
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Retry')
    ).toBe(true)
  })
  it('renders response owner/tier and leaves full-page ledger data untouched', async () => {
    await render()
    expect(container.textContent).toContain('Group · actual-group')
    expect(container.textContent).toContain('Panel entry')
    expect(container.textContent).not.toContain('Filed here')
    expect(container.textContent).not.toContain('full-page-entry')
    expect(mocks.store.ledgerEntries).toEqual(['full-page-entry'])
    expect(mocks.store.ledgerSummary).toEqual({ ledgerId: 'full-page' })
    expect(mocks.store.loadLedger).not.toHaveBeenCalled()
  })
  it('names the response owner using the owning runtime catalog', async () => {
    mocks.environmentId = 'paired'
    mocks.catalog.mockResolvedValue({
      projects: [],
      groups: [{ id: 'actual-group', name: 'Actual group name' }]
    })
    await render()
    expect(mocks.catalog).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'paired' },
      'projectGroup.list'
    )
    expect(container.textContent).toContain('Group · Actual group name')
  })
  it('falls back to the response ID when the owner catalog fails', async () => {
    mocks.catalog.mockRejectedValue(new Error('Catalog unavailable'))
    await render()
    expect(container.textContent).toContain('Group · actual-group')
    expect(container.textContent).toContain('Panel entry')
  })
  it('routes paired reads and new entries through the captured workspace owner', async () => {
    mocks.environmentId = 'paired'
    await render()
    expect(mocks.runtimeSettings).toHaveBeenCalledWith('worktree-a')
    expect(mocks.request).toHaveBeenCalledWith(
      {
        operation: 'list',
        target: { workspaceId: 'worktree-a' },
        filters: { workspaceId: 'worktree-a' }
      },
      'paired'
    )
    await click('New')
    expect(mocks.form?.environmentId).toBe('paired')
    await act(async () => {
      await mocks.form!.onSubmit('bug', { title: 'New bug' })
    })
    expect(mocks.request).toHaveBeenCalledWith(
      {
        operation: 'file',
        type: 'bug',
        content: { title: 'New bug' },
        target: { workspaceId: 'worktree-a' }
      },
      'paired'
    )
    await click('Triage')
    expect(mocks.triage?.environmentId).toBe('paired')
    expect(mocks.triage?.target).toEqual({ workspaceId: 'worktree-a' })
  })
  it('clears dialogs on selection changes and delays hidden workspace fetches', async () => {
    await render()
    await click('New')
    expect(container.querySelector('[data-dialog="form"]')).not.toBeNull()
    await render(false)
    mocks.store.activeWorktreeId = 'worktree-b'
    await render(false)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-dialog]')).toBeNull()
    expect(container.textContent).not.toContain('Panel entry')
    await render(true)
    expect(mocks.request).toHaveBeenLastCalledWith(
      {
        operation: 'list',
        target: { workspaceId: 'worktree-b' },
        filters: { workspaceId: 'worktree-b' }
      },
      undefined
    )
    expect(container.querySelector('[data-dialog]')).toBeNull()
  })
  it('defaults to this worktree and widens to the project and group ledgers on demand', async () => {
    await render()
    expect(mocks.request).toHaveBeenLastCalledWith(
      {
        operation: 'list',
        target: { workspaceId: 'worktree-a' },
        filters: { workspaceId: 'worktree-a' }
      },
      undefined
    )
    await click('Project')
    expect(mocks.request).toHaveBeenLastCalledWith(
      { operation: 'list', target: { workspaceId: 'worktree-a' }, filters: {} },
      undefined
    )
    await click('Group')
    expect(mocks.request).toHaveBeenLastCalledWith(
      { operation: 'list', target: { workspaceId: 'worktree-a', group: true }, filters: {} },
      undefined
    )
    await click('New')
    await act(async () => {
      await mocks.form!.onSubmit('bug', { title: 'Group bug' })
    })
    expect(mocks.request).toHaveBeenCalledWith(
      {
        operation: 'file',
        type: 'bug',
        content: { title: 'Group bug' },
        target: { workspaceId: 'worktree-a', group: true }
      },
      undefined
    )
  })
  it('hides the group tier when the workspace belongs to no group', async () => {
    mocks.store.repos = [{ id: 'repo-a' }]
    await render()
    const labels = [...container.querySelectorAll('[aria-pressed]')].map((node) => node.textContent)
    expect(labels).toEqual(['Worktree', 'Project'])
  })
  it('hides the project tier for a folder workspace', async () => {
    mocks.store.activeWorktreeId = null
    mocks.store.activeWorkspaceKey = 'folder:folder-a'
    await render()
    const labels = [...container.querySelectorAll('[aria-pressed]')].map((node) => node.textContent)
    expect(labels).toEqual(['Folder', 'Group'])
  })
  it('refetches on visible selection changes and closes detail', async () => {
    await render()
    const row = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Panel entry')
    )!
    await act(async () => row.click())
    expect(container.querySelector('[data-dialog="detail"]')).not.toBeNull()
    mocks.store.activeWorktreeId = 'worktree-b'
    await render()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-dialog="detail"]')).toBeNull()
  })
  it('resets dialogs and routes again when the same workspace changes runtime owner', async () => {
    await render()
    await click('New')
    mocks.environmentId = 'paired-b'
    await render()
    expect(container.querySelector('[data-dialog]')).toBeNull()
    expect(mocks.request).toHaveBeenLastCalledWith(
      {
        operation: 'list',
        target: { workspaceId: 'worktree-a' },
        filters: { workspaceId: 'worktree-a' }
      },
      'paired-b'
    )
  })
  it('adapts rejected detail mutations to boolean failure and inline error', async () => {
    await render()
    const row = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Panel entry')
    )!
    await act(async () => row.click())
    mocks.request.mockRejectedValueOnce(new Error('Revision conflict'))
    await act(async () => {
      expect(
        await mocks.detail!.onMutate({
          operation: 'state',
          id: entry.id,
          state: 'resolved',
          ifRevision: 1
        })
      ).toBe(false)
    })
    expect(mocks.detail?.error).toBe('Revision conflict')
    expect(mocks.detail?.pending).toBe(false)
  })
  it('searches title and ID locally without issuing a new request', async () => {
    await render()
    const input = container.querySelector('input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const [query, found] of [
      ['missing', false],
      ['bug-1', true],
      ['PANEL', true]
    ] as const) {
      await act(async () => {
        setter.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(container.textContent?.includes('Panel entry')).toBe(found)
    }
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('passes compact filters to list and triage, preserving false values', async () => {
    await render()
    for (const [index, value] of [
      [0, 'decision'],
      [1, 'resolved'],
      [2, 'false'],
      [3, 'true']
    ] as const) {
      await act(async () => {
        const select = container.querySelectorAll('select')[index]
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    const filters = {
      type: 'decision',
      state: 'resolved',
      reviewed: false,
      stale: true,
      workspaceId: 'worktree-a'
    }
    expect(mocks.request).toHaveBeenLastCalledWith(
      { operation: 'list', target: { workspaceId: 'worktree-a' }, filters },
      undefined
    )
    await click('Triage')
    expect(mocks.triage?.filters).toEqual(filters)
  })
  it('shows a generic retry and recovers', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Connection lost'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Connection lost')
    await click('Retry')
    expect(container.textContent).toContain('Panel entry')
  })
  it('defers the loading spinner by 200ms', async () => {
    vi.useFakeTimers()
    mocks.request.mockReturnValue(new Promise<LedgerResponse>(() => {}))
    await render()
    expect(container.querySelector('.animate-spin')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(199)
    })
    expect(container.querySelector('.animate-spin')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })
  it('keeps an in-flight mutation attached to its original workspace', async () => {
    await render()
    await click('New')
    let finish!: (response: LedgerResponse) => void
    mocks.request.mockImplementationOnce(
      (_request: LedgerRequest) =>
        new Promise<LedgerResponse>((resolve) => {
          finish = resolve
        })
    )
    let pending!: Promise<void>
    await act(async () => {
      pending = mocks.form!.onSubmit('bug', { title: 'Old workspace' })
    })
    mocks.store.activeWorktreeId = 'worktree-b'
    await render()
    await act(async () => {
      finish(response())
      await pending
    })
    expect(mocks.request.mock.calls.filter(([request]) => request.operation === 'file')).toEqual([
      [
        {
          operation: 'file',
          type: 'bug',
          content: { title: 'Old workspace' },
          target: { workspaceId: 'worktree-a' }
        },
        undefined
      ]
    ])
    expect(container.querySelector('[data-dialog]')).toBeNull()
  })
})
