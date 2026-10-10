import { describe, expect, it } from 'vitest'
import { validationMessagesByNode } from './pipeline-node-validation-messages'

describe('validationMessagesByNode', () => {
  it('groups messages by node id in the order they were reported', () => {
    const grouped = validationMessagesByNode([
      { nodeId: 'build', message: 'Prompt is empty' },
      { nodeId: 'test', message: 'Unknown dependency "lint"' },
      { nodeId: 'build', message: 'Timeout is out of range' }
    ])

    expect([...grouped.keys()]).toEqual(['build', 'test'])
    expect(grouped.get('build')).toEqual(['Prompt is empty', 'Timeout is out of range'])
    expect(grouped.get('test')).toEqual(['Unknown dependency "lint"'])
  })

  it('leaves out document-level errors that name no node', () => {
    const grouped = validationMessagesByNode([
      { nodeId: null, message: 'Pipeline id does not match the file name' },
      { nodeId: 'build', message: 'Prompt is empty' }
    ])

    expect([...grouped.keys()]).toEqual(['build'])
  })

  it('returns an empty map when nothing failed validation', () => {
    expect(validationMessagesByNode([]).size).toBe(0)
  })

  it('returns nothing for a node that has no errors', () => {
    expect(validationMessagesByNode([{ nodeId: 'build', message: 'x' }]).get('other')).toBe(
      undefined
    )
  })
})
