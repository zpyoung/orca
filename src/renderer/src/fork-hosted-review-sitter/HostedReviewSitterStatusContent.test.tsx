// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeParkReason } from '../../../shared/fork-heimdall/park-reason-description'
import type {
  WatcherEnrollment,
  WatcherListEntry
} from '../../../shared/fork-heimdall/watcher-types'
import { HostedReviewSitterStatusContent } from './HostedReviewSitterStatusContent'

afterEach(cleanup)

function enrollment(): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: false,
    paused: false,
    commandRevision: 1,
    capabilities: { write: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'tab:leaf' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

function entryParkedOnStopPredicate(reasonText: string): WatcherListEntry {
  const parkReason = {
    kind: 'stop-predicate' as const,
    predicateId: 'objective-bar-reached',
    reason: reasonText
  }
  return {
    name: 'watcher-1',
    enrollment: enrollment(),
    status: {
      watcherId: 'watcher-1',
      enabled: false,
      state: 'parked',
      phase: 'parked',
      reason: describeParkReason(parkReason),
      parkReason,
      budget: { activeMs: 0, turns: 0, exhausted: null },
      startedAtMs: 1,
      lastSuccessfulTickAtMs: null,
      nextPulseAtMs: null
    }
  }
}

function baseProps(
  entry: WatcherListEntry
): ComponentProps<typeof HostedReviewSitterStatusContent> {
  return {
    entry,
    ledger: null,
    approvalScope: null,
    ledgerOpen: false,
    readOnly: false,
    readOnlyReason: null,
    busy: false,
    stopping: false,
    approving: false,
    active: false,
    copyingDebugReport: false,
    debugReportCopied: false,
    onLedgerOpenChange: vi.fn(),
    onStop: vi.fn(),
    onApprove: vi.fn(),
    onCopyDebugReport: vi.fn()
  }
}

describe('HostedReviewSitterStatusContent', () => {
  it('shows the described park reason instead of the bare park-reason kind', () => {
    const entry = entryParkedOnStopPredicate('files-on-disk landing bar reached')
    render(<HostedReviewSitterStatusContent {...baseProps(entry)} />)

    expect(screen.getByText('files-on-disk landing bar reached')).toBeInTheDocument()
    expect(screen.queryByText('stop-predicate')).not.toBeInTheDocument()
  })
})
