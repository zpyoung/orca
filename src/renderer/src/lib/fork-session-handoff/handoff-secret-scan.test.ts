import { describe, expect, it } from 'vitest'
import { scanHandoffBriefForSecrets } from './handoff-secret-scan'

const secretCases = [
  ['aws-access-key-id', 'AKIA1234567890ABCDEF'],
  ['github-token', `ghp_${'A'.repeat(36)}`],
  ['stripe-key', 'sk_live_1234567890'],
  ['slack-token', 'xoxb-1234567890'],
  ['private-key-header', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['env-assignment', 'api_key="abcdefghijklmnop']
] as const

describe('scanHandoffBriefForSecrets', () => {
  it.each(secretCases)('detects %s with exact offsets', (ruleId, secret) => {
    const prefix = 'header\nvalue: '
    const text = `${prefix}${secret} trailing`
    const hits = scanHandoffBriefForSecrets(text)
    const hit = hits.find((candidate) => candidate.ruleId === ruleId)

    expect(hit).toBeDefined()
    expect(hit?.line).toBe(2)
    expect(text.slice(hit?.start, hit?.end)).toBe(secret)
    expect(hit?.redactedExcerpt).toBe(`${secret.slice(0, 4)}…`)
  })

  it('detects every configured token prefix variant', () => {
    const variants = [
      `ghp_${'a'.repeat(36)}`,
      `gho_${'a'.repeat(36)}`,
      `ghu_${'a'.repeat(36)}`,
      `ghs_${'a'.repeat(36)}`,
      `ghr_${'a'.repeat(36)}`,
      'sk_test_abcdefghij',
      'xoxa-1234567890',
      'xoxp-1234567890',
      'xoxr-1234567890',
      'xoxs-1234567890',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'CREDENTIALS: ABCDEFGHIJKLMNOP'
    ]

    expect(scanHandoffBriefForSecrets(variants.join('\n')).map((hit) => hit.ruleId)).toEqual([
      'github-token',
      'github-token',
      'github-token',
      'github-token',
      'github-token',
      'stripe-key',
      'slack-token',
      'slack-token',
      'slack-token',
      'slack-token',
      'private-key-header',
      'env-assignment'
    ])
  })

  it('keeps full matches out of serialized scan results', () => {
    const secret = `ghp_${'z'.repeat(36)}`
    const serialized = JSON.stringify(scanHandoffBriefForSecrets(secret))

    expect(serialized).not.toContain(secret)
    expect(serialized).toContain('ghp_…')
  })

  it('returns overlapping structural findings in source order', () => {
    const githubToken = `ghp_${'B'.repeat(36)}`
    const text = `TOKEN=${githubToken}\nAKIA1234567890ABCDEF`
    const hits = scanHandoffBriefForSecrets(text)

    expect(hits.map((hit) => [hit.ruleId, hit.start, hit.end, hit.line])).toEqual([
      ['env-assignment', 0, `TOKEN=${githubToken}`.length, 1],
      ['github-token', 'TOKEN='.length, `TOKEN=${githubToken}`.length, 1],
      [
        'aws-access-key-id',
        `TOKEN=${githubToken}\n`.length,
        `TOKEN=${githubToken}\nAKIA1234567890ABCDEF`.length,
        2
      ]
    ])
  })

  it.each([
    '550e8400-e29b-41d4-a716-446655440000',
    '0123456789abcdef0123456789abcdef01234567',
    'highEntropyButUnstructured0123456789+/=',
    'ghp_too_short',
    'akia1234567890abcdef',
    '-----begin private key-----',
    'ordinary_token_name_without_assignment',
    'password=short'
  ])('does not flag precision control %s', (text) => {
    expect(scanHandoffBriefForSecrets(text)).toEqual([])
  })

  it('re-scans edited text instead of preserving stale ranges', () => {
    const original = `prefix AKIA1234567890ABCDEF suffix`
    const originalHit = scanHandoffBriefForSecrets(original)[0]
    const edited = original.replace('prefix ', '')
    const editedHit = scanHandoffBriefForSecrets(edited)[0]

    expect(editedHit.start).not.toBe(originalHit.start)
    expect(edited.slice(editedHit.start, editedHit.end)).toBe('AKIA1234567890ABCDEF')
  })
})
