// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import {
  buildWatcherFleetEntry as row,
  deferred
} from '../../../shared/fork-heimdall/fleet-test-fixtures'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import { useAppStore } from '@/store'
import { ObjectiveDetailContent } from './ObjectiveDetailContent'
import { ObjectiveDetailSection } from './ObjectiveDetailSection'

function detail(objectiveText: string, asOfMs: number): ObjectiveDetail {
  return {
    contract: {
      objectiveText,
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'git',
      writeTerritory: ['src/**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    revisions: [],
    nodes: [],
    verdicts: [],
    landing: [],
    asOfMs
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

let root: Root
let container: HTMLDivElement
let previousApi: unknown

beforeEach(() => {
  previousApi = window.api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
  useAppStore.setState({ folderWorkspaces: [] })
})

function installApi(overrides: Partial<HeimdallApi>): void {
  const api = {
    enroll: vi.fn(),
    onFleetChanged: vi.fn(() => () => {}),
    ...overrides
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { heimdall: api }
  })
}

describe('ObjectiveDetailSection', () => {
  it('renders the remote-safe unavailable state when the optional method is absent', async () => {
    installApi({})
    await act(async () => root.render(<ObjectiveDetailSection row={row(1)} ledger={null} />))

    expect(container.textContent).toContain('Objective detail is not available from this host.')
  })

  it('maps an old host unknown-method refusal to the unavailable state', async () => {
    installApi({
      objectiveDetail: vi.fn(() =>
        Promise.reject(new Error('Unknown method: heimdall:objectiveDetail'))
      )
    })
    await act(async () => root.render(<ObjectiveDetailSection row={row(1)} ledger={null} />))
    await flushEffects()

    expect(container.textContent).toContain('Objective detail is not available from this host.')
    expect(container.textContent).not.toContain('could not be loaded')
  })

  it('labels a canonical folder workspace from its host-qualified catalog row', async () => {
    const folderRow = row(1)
    folderRow.entry.enrollment = {
      ...folderRow.entry.enrollment,
      executionHostId: 'local',
      repoId: 'folder-workspace:personal',
      worktreeId: 'folder:notes',
      workspacePath: '/workspace/notes'
    }
    const folderDetail = detail('Maintain notes', 1)
    folderDetail.contract = { ...folderDetail.contract, workspaceKind: 'folder' }
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'notes',
          projectGroupId: 'personal',
          name: 'Canonical notes',
          folderPath: '/workspace/notes',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1,
          executionHostId: 'local'
        }
      ]
    })

    await act(async () =>
      root.render(<ObjectiveDetailContent detail={folderDetail} ledger={null} row={folderRow} />)
    )

    expect(container.textContent).toContain('Folder · Canonical notes')
    expect(container.textContent).not.toContain('folder:notes')
  })

  it('does not let an older response overwrite a newer owner revision', async () => {
    const first = deferred<ObjectiveDetail>()
    const second = deferred<ObjectiveDetail>()
    const objectiveDetail = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    installApi({ objectiveDetail })

    await act(async () => root.render(<ObjectiveDetailSection row={row(1, 10)} ledger={null} />))
    await flushEffects()
    await act(async () => root.render(<ObjectiveDetailSection row={row(2, 20)} ledger={null} />))
    await flushEffects()
    await act(async () => {
      second.resolve(detail('New owner state', 20))
      await second.promise
    })
    expect(container.textContent).toContain('New owner state')

    await act(async () => {
      first.resolve(detail('Stale owner state', 10))
      await first.promise
    })
    expect(container.textContent).toContain('New owner state')
    expect(container.textContent).not.toContain('Stale owner state')
  })
})
