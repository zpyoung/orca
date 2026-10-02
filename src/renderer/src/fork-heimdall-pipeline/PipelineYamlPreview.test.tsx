// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PipelineYamlPreview } from './PipelineYamlPreview'

afterEach(cleanup)

describe('PipelineYamlPreview', () => {
  it('keeps generated YAML read-only', () => {
    render(<PipelineYamlPreview text="name: Bugfix" />)

    expect(screen.getByRole('textbox', { name: 'Read-only pipeline YAML' })).toHaveProperty(
      'readOnly',
      true
    )
  })
})
