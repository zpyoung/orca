import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../linear/client'
import { _resetPreflightCache } from './preflight'
import {
  getIssue,
  searchIssues,
  listIssues,
  createIssue,
  updateIssue,
  addIssueComment,
  getIssueComments
} from '../linear/issues'
import {
  createProject,
  getCustomView,
  getProject,
  listCustomViewIssues,
  listCustomViewProjects,
  listCustomViews,
  listProjectIssues,
  listProjects
} from '../linear/projects'
import { listTeams, getTeamStates, getTeamLabels, getTeamMembers } from '../linear/teams'
import type { LinearListFilter } from '../linear/issues'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import { optionalParsedLinearIssueAttributeFilter } from '../../shared/linear/issue-attribute-filter'
import type { LinearIssueUpdate } from '../../shared/issue-mutation-types'
import type { LinearCustomViewModel } from '../../shared/linear/project-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

const VALID_FILTERS = new Set<LinearListFilter>(['assigned', 'created', 'all', 'completed'])

function normalizeWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeWorkspaceSelection(value: unknown): LinearWorkspaceSelection | undefined {
  const workspaceId = normalizeWorkspaceId(value)
  return workspaceId as LinearWorkspaceSelection | undefined
}

function normalizeConcreteWorkspaceId(value: unknown): string {
  const workspaceId = normalizeWorkspaceId(value)
  if (!workspaceId || workspaceId === 'all') {
    throw new Error('Concrete Linear workspace ID is required')
  }
  return workspaceId
}

function normalizeCustomViewModel(value: unknown): LinearCustomViewModel {
  if (value !== 'issue' && value !== 'project') {
    throw new Error('Custom view model is required')
  }
  return value
}

function normalizeIdList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    !Array.isArray(value) ||
    !value.every((id): id is string => typeof id === 'string' && Boolean(id.trim()))
  ) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.map((id) => id.trim())
}

function normalizeOptionalDate(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.trim()
}

export function registerLinearHandlers(): void {
  ipcMain.handle('linear:connect', async (_event, args: { apiKey: string }) => {
    if (typeof args?.apiKey !== 'string' || !args.apiKey.trim()) {
      return { ok: false, error: 'Invalid API key' }
    }
    const result = await connect(args.apiKey.trim())
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('linear:disconnect', async (_event, args?: { workspaceId?: string }) => {
    disconnect(normalizeWorkspaceId(args?.workspaceId))
    _resetPreflightCache()
  })

  ipcMain.handle('linear:selectWorkspace', async (_event, args: { workspaceId: string }) => {
    const workspaceId = normalizeWorkspaceSelection(args?.workspaceId)
    if (!workspaceId) {
      return getStatus()
    }
    return selectWorkspace(workspaceId)
  })

  ipcMain.handle('linear:status', async () => {
    return getStatus()
  })

  ipcMain.handle('linear:testConnection', async (_event, args?: { workspaceId?: string }) => {
    return testConnection(normalizeWorkspaceId(args?.workspaceId))
  })

  registerLinearIssueHandlers()
  registerLinearProjectHandlers()
  registerLinearCustomViewHandlers()
  registerLinearTeamHandlers()
}
