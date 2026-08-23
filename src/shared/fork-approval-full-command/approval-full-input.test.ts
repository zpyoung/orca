import { describe, expect, it } from 'vitest'

import { APPROVAL_FULL_INPUT_MAX_LENGTH, approvalFullInputFields } from './approval-full-input'
import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from '../agent-status-types'

// Mirrors summarizeApprovalInput in agent-hook-listener.ts, whose preview these
// fields sit beside — the "already whole" check compares against exactly it.
function preview(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value
}

describe('approvalFullInputFields', () => {
  it('adds nothing when the preview already shows the whole command', () => {
    const command = 'git status'
    expect(approvalFullInputFields({ command }, preview(command))).toEqual({})
  })

  it('carries the untruncated command, its field name, and its length', () => {
    const command = `git commit -m "${'x'.repeat(400)}"`
    expect(approvalFullInputFields({ command }, preview(command))).toEqual({
      full: command,
      fullField: 'command',
      fullLength: command.length
    })
  })

  it('preserves the line breaks of a multi-line command', () => {
    const command = `${'a'.repeat(150)}\n${'b'.repeat(150)}\n${'c'.repeat(150)}`
    expect(approvalFullInputFields({ command }, preview(command)).full).toBe(command)
  })

  it('names the field a non-command approval came from', () => {
    const url = `https://example.com/${'p'.repeat(400)}`
    expect(approvalFullInputFields({ url }, preview(url))).toEqual({
      full: url,
      fullField: 'url',
      fullLength: url.length
    })
  })

  it('falls back to the serialized input when no known field is present', () => {
    const input = { note: 'y'.repeat(400) }
    const json = JSON.stringify(input)
    expect(approvalFullInputFields(input, preview(json))).toEqual({
      full: json,
      fullField: 'json',
      fullLength: json.length
    })
  })

  it('falls back to JSON when the first present field is empty, matching the preview', () => {
    const input = { command: '', file_path: `/tmp/${'a'.repeat(400)}` }
    const json = JSON.stringify(input)
    expect(approvalFullInputFields(input, preview(json))).toEqual({
      full: json,
      fullField: 'json',
      fullLength: json.length
    })
  })

  it('reports the true length of a command the raw cap cut, and never fakes an ellipsis', () => {
    const command = 'z'.repeat(APPROVAL_FULL_INPUT_MAX_LENGTH + 500)
    const fields = approvalFullInputFields({ command }, preview(command))
    expect(fields.full).toHaveLength(APPROVAL_FULL_INPUT_MAX_LENGTH)
    // an appended marker would be copied along with the command as if it were part of it
    expect(fields.full?.endsWith('…')).toBe(false)
    expect(fields.fullLength).toBe(command.length)
  })

  it('keeps the encoded envelope under the interactivePrompt cap for escape-heavy input', () => {
    // a control character encodes to six (\uXXXX), the worst JSON.stringify does
    const command = '\u0001'.repeat(APPROVAL_FULL_INPUT_MAX_LENGTH)
    const fields = approvalFullInputFields({ command }, preview(command))
    const envelope = JSON.stringify({
      approval: { tool: 'Bash', summary: preview(command), ...fields }
    })
    expect(envelope.length).toBeLessThan(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
    // the encoded budget cuts deeper than the raw cap here; the reader is told how much
    expect(fields.full!.length).toBeLessThan(APPROVAL_FULL_INPUT_MAX_LENGTH)
    expect(fields.fullLength).toBe(command.length)
  })

  it('never cuts between a surrogate pair', () => {
    const command = '\u{1f680}'.repeat(APPROVAL_FULL_INPUT_MAX_LENGTH)
    const { full } = approvalFullInputFields({ command }, preview(command))
    expect(full).toBeDefined()
    expect([...(full ?? '')].every((char) => char !== '�')).toBe(true)
  })
})
