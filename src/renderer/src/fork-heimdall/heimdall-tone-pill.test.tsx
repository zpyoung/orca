// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HeimdallTonePill } from './heimdall-tone-pill'

afterEach(cleanup)

describe('HeimdallTonePill destructive tone', () => {
  it('uses the destructive status tokens for confirmed failures', () => {
    render(<HeimdallTonePill tone="destructive">Failed</HeimdallTonePill>)

    const pill = screen.getByText('Failed')
    expect(pill).toHaveAttribute('data-tone', 'destructive')
    expect(pill).toHaveClass('border-destructive/30', 'bg-destructive/10', 'text-destructive')
  })
})
