import { describe, expect, it } from 'vitest'

import { ASK_COMMAND_SPECS } from './specs'
import { effectiveAllowedFlags } from '../args'
import { formatCommandHelp } from '../help'

function spec(path: string): (typeof ASK_COMMAND_SPECS)[number] {
  const found = ASK_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing ask spec: ${path}`)
  }
  return found
}

describe('ask command specs', () => {
  it('does not accept or advertise browser page targeting', () => {
    for (const entry of ASK_COMMAND_SPECS) {
      expect(effectiveAllowedFlags(entry)).not.toContain('page')
      expect(formatCommandHelp(entry)).not.toContain('--page')
    }
  })

  it('renders --json and --help in its Options block', () => {
    for (const entry of ASK_COMMAND_SPECS) {
      const help = formatCommandHelp(entry)
      expect(help).toContain('--json')
      expect(help).toContain('--help')
    }
  })

  it('requires --spec on the bare ask command', () => {
    const help = formatCommandHelp(spec('ask'))
    expect(effectiveAllowedFlags(spec('ask'))).toContain('spec')
    expect(help).toContain('--spec')
  })

  it('requires --id on ask wait and ask cancel', () => {
    for (const path of ['ask wait', 'ask cancel']) {
      expect(effectiveAllowedFlags(spec(path))).toContain('id')
      expect(formatCommandHelp(spec(path))).toContain('--id')
    }
  })
})
