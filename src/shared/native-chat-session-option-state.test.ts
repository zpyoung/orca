import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import {
  applyNativeChatReportedSessionOptions,
  createNativeChatSessionOptionRecord,
  matchNativeChatCatalogModelId,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'

function claudeRecord(): NativeChatSessionOptionRecord {
  return createNativeChatSessionOptionRecord('claude')
}

describe('applyNativeChatReportedSessionOptions', () => {
  it('reports become authority and reset stale per-model values on a model change', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'dispatched' }
    record.valuesByModel.opus = { effort: { value: 'high', source: 'dispatched' } }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'opus' })).toBe(true)
    expect(record.model).toEqual({ value: 'opus', source: 'reported' })
    // A model change invalidates previously tracked values for the destination.
    expect(record.valuesByModel.opus).toEqual({})
  })

  it('promotes a dispatched guess the report confirms', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'dispatched' }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' })).toBe(true)
    expect(record.model).toEqual({ value: 'sonnet', source: 'reported' })
  })

  it('keeps locally tracked options when the reported model is unchanged', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'reported' }
    record.valuesByModel.sonnet = { effort: { value: 'high', source: 'dispatched' } }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' })).toBe(false)
    expect(record.valuesByModel.sonnet?.effort).toEqual({ value: 'high', source: 'dispatched' })
  })

  it('is a no-op when the report matches tracked state', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'reported' }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' })).toBe(false)
  })
})

describe('applyNativeChatReportedSessionOptions staleness guard', () => {
  it('ignores a report from a turn that predates a dispatched pick', () => {
    const record = claudeRecord()
    record.model = { value: 'opus', source: 'reported' }
    record.valuesByModel.opus = { effort: { value: 'max', source: 'dispatched', at: 200 } }
    // The turn was already in flight when /effort max was sent, so it still records
    // the previous level; folding it in would revert the pill under the user.
    expect(
      applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' }, 100)
    ).toBe(false)
    expect(record.valuesByModel.opus?.effort).toEqual({
      value: 'max',
      source: 'dispatched',
      at: 200
    })
  })

  it('applies a report from a turn that ran after the pick', () => {
    const record = claudeRecord()
    record.model = { value: 'opus', source: 'reported' }
    record.valuesByModel.opus = { effort: { value: 'max', source: 'dispatched', at: 100 } }
    expect(
      applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' }, 200)
    ).toBe(true)
    expect(record.valuesByModel.opus?.effort).toEqual({ value: 'high', source: 'reported' })
  })

  it('drops the whole report when it predates a dispatched model switch', () => {
    const record = claudeRecord()
    record.model = { value: 'sonnet', source: 'dispatched', at: 200 }
    // The report describes the model that was running before the switch, so its
    // effort belongs to that model too and none of it may be folded in.
    expect(
      applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' }, 100)
    ).toBe(false)
    expect(record.model).toEqual({ value: 'sonnet', source: 'dispatched', at: 200 })
    expect(record.valuesByModel.opus).toBeUndefined()
  })

  it('fails open when either side carries no timestamp', () => {
    const undated = claudeRecord()
    undated.model = { value: 'opus', source: 'reported' }
    undated.valuesByModel.opus = { effort: { value: 'max', source: 'dispatched' } }
    expect(
      applyNativeChatReportedSessionOptions(undated, { model: 'opus', effort: 'high' }, 100)
    ).toBe(true)

    const unstamped = claudeRecord()
    unstamped.model = { value: 'opus', source: 'reported' }
    unstamped.valuesByModel.opus = { effort: { value: 'max', source: 'dispatched', at: 200 } }
    expect(
      applyNativeChatReportedSessionOptions(unstamped, { model: 'opus', effort: 'high' })
    ).toBe(true)
  })

  it('never withholds a report from an applied launch value', () => {
    // Only a dispatched pick can outrank a report: an applied value describes the
    // launch, which the agent's own log supersedes the moment it says otherwise.
    const record = claudeRecord()
    record.model = { value: 'opus', source: 'applied', at: 500 }
    expect(applyNativeChatReportedSessionOptions(record, { model: 'sonnet' }, 100)).toBe(true)
    expect(record.model).toEqual({ value: 'sonnet', source: 'reported' })
  })
})

describe('matchNativeChatCatalogModelId', () => {
  it('matches exact ids, labels, and provider-id containment', () => {
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'sonnet')).toBe('sonnet')
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'Sonnet 5')).toBe('sonnet')
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'claude-sonnet-5')).toBe(
      'sonnet'
    )
    expect(matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, 'gpt-5.5')).toBe('gpt-5.5')
  })

  it('returns null for unrecognized reports', () => {
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'mystery-model')).toBeNull()
    expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, '')).toBeNull()
  })
})
