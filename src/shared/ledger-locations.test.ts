import { describe, expect, it } from 'vitest'
import { normalizeLedgerLocation, ledgerLocationKey } from './ledger-locations'

const context = {
  base: { kind: 'project' as const, id: 'p1', host: 'builder' },
  rootPath: 'C:\\repo',
  platform: 'win32' as const,
  host: 'builder'
}
describe('ledger locations', () => {
  it('normalizes Windows paths relative to the host root', () => {
    expect(normalizeLedgerLocation('C:\\repo\\src\\a.ts', context)).toMatchObject({
      path: 'src/a.ts',
      external: false
    })
    expect(normalizeLedgerLocation('D:\\other\\a.ts', context)).toMatchObject({
      path: 'D:/other/a.ts',
      external: true,
      host: 'builder'
    })
    expect(
      normalizeLedgerLocation('D:\\outside\\a.ts:12', { ...context, host: 'windows-host' })
    ).toMatchObject({ path: 'D:/outside/a.ts', line: 12, external: true, host: 'windows-host' })
    expect(normalizeLedgerLocation('../outside/a.ts:12', context)).toMatchObject({
      path: 'C:/outside/a.ts',
      line: 12,
      external: true,
      host: 'builder'
    })
    expect(normalizeLedgerLocation('\\\\server\\share\\a.ts:7', context)).toMatchObject({
      path: '//server/share/a.ts',
      line: 7,
      external: true
    })
  })
  it('rejects invalid raw line suffixes and preserves explicit structured lines', () => {
    expect(() => normalizeLedgerLocation('src/a.ts:0', context)).toThrow()
    expect(
      normalizeLedgerLocation({ path: 'src/a.ts', line: 9, base: context.base }, context)
    ).toMatchObject({ path: 'src/a.ts', line: 9 })
    expect(
      normalizeLedgerLocation('/repo/src/a.ts:12', {
        base: context.base,
        rootPath: '/repo',
        platform: 'posix',
        host: 'builder'
      })
    ).toMatchObject({ path: 'src/a.ts', line: 12, external: false })
  })
  it('qualifies workspace locations by host but project locations by project identity', () => {
    const a = { path: 'src/a.ts', base: { kind: 'project' as const, id: 'old' } }
    const b = { path: 'src/a.ts', base: { kind: 'project' as const, id: 'new' } }
    expect(ledgerLocationKey(a, [['old', 'new']])).toBe(ledgerLocationKey(b, [['old', 'new']]))
    expect(ledgerLocationKey({ ...a, path: 'src/A.ts' })).not.toBe(
      ledgerLocationKey({ ...a, path: 'src/a.ts' })
    )
    expect(
      ledgerLocationKey({ ...a, base: { kind: 'project', id: 'a' } }, [
        ['a', 'b'],
        ['b', 'c']
      ])
    ).toBe(
      ledgerLocationKey({ ...a, base: { kind: 'project', id: 'c' } }, [
        ['a', 'b'],
        ['b', 'c']
      ])
    )
    expect(
      ledgerLocationKey({
        path: 'src/a.ts',
        external: true,
        host: 'one',
        base: { kind: 'project', id: 'p1' }
      })
    ).not.toBe(
      ledgerLocationKey({
        path: 'src/a.ts',
        external: true,
        host: 'two',
        base: { kind: 'project', id: 'p1' }
      })
    )
  })
})
