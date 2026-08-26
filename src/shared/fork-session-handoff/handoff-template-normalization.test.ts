import { describe, expect, it } from 'vitest'
import {
  HANDOFF_TEMPLATE_BODY_MAX,
  HANDOFF_TEMPLATE_NAME_MAX,
  HANDOFF_TEMPLATES_MAX,
  normalizeHandoffTemplates
} from './handoff-template-normalization'

describe('normalizeHandoffTemplates', () => {
  it('rejects non-arrays and drops malformed or blank rows', () => {
    expect(normalizeHandoffTemplates(undefined)).toEqual([])
    expect(normalizeHandoffTemplates({})).toEqual([])
    expect(
      normalizeHandoffTemplates([
        null,
        [],
        { id: 'missing-body', name: 'Name' },
        { id: 'blank-name', name: '  ', body: 'Body' },
        { id: 'valid', name: ' Name ', body: ' Body ' }
      ])
    ).toEqual([{ id: 'valid', name: 'Name', body: 'Body' }])
  })

  it('trims and truncates names and bodies', () => {
    const [template] = normalizeHandoffTemplates([
      {
        id: 'long',
        name: `  ${'n'.repeat(HANDOFF_TEMPLATE_NAME_MAX + 4)}  `,
        body: `  ${'b'.repeat(HANDOFF_TEMPLATE_BODY_MAX + 4)}  `
      }
    ])

    expect(template?.name).toHaveLength(HANDOFF_TEMPLATE_NAME_MAX)
    expect(template?.body).toHaveLength(HANDOFF_TEMPLATE_BODY_MAX)
  })

  it('keeps the first duplicate id and generates missing ids', () => {
    let counter = 0
    expect(
      normalizeHandoffTemplates(
        [
          { id: 'same', name: 'First', body: 'One' },
          { id: 'same', name: 'Second', body: 'Two' },
          { name: 'Generated', body: 'Three' },
          { id: ' ', name: 'Generated two', body: 'Four' }
        ],
        { createId: () => `generated-${++counter}` }
      )
    ).toEqual([
      { id: 'same', name: 'First', body: 'One' },
      { id: 'generated-1', name: 'Generated', body: 'Three' },
      { id: 'generated-2', name: 'Generated two', body: 'Four' }
    ])
  })

  it('caps the normalized catalog', () => {
    const templates = Array.from({ length: HANDOFF_TEMPLATES_MAX + 5 }, (_, index) => ({
      id: `template-${index}`,
      name: `Template ${index}`,
      body: `Body ${index}`
    }))

    expect(normalizeHandoffTemplates(templates)).toHaveLength(HANDOFF_TEMPLATES_MAX)
  })
})
