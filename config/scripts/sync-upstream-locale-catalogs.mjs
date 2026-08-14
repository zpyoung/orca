#!/usr/bin/env node
/**
 * Reconciles the fork's i18n catalogs with an upstream release during a sync merge.
 *
 * Upstream owns every key it defines. The fork's catalogs carry English fallbacks written by
 * `sync:localization-catalog`, and a fork-wins merge lets those fallbacks shadow upstream's
 * real translations — the UI silently reverts to English in non-English locales. The fork keeps
 * only the keys upstream has no opinion on, which are the strings for its own features.
 *
 * Usage:
 *   node config/scripts/sync-upstream-locale-catalogs.mjs <target-ref>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TARGET = process.argv[2]
if (!TARGET) {
  console.error('usage: sync-upstream-locale-catalogs.mjs <target-ref>')
  process.exit(2)
}

const LOCALES = ['en', 'es', 'ja', 'ko', 'zh']
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function reconcile(fork, upstream, stats) {
  const merged = {}
  for (const [key, upstreamValue] of Object.entries(upstream)) {
    const forkValue = fork?.[key]
    if (isPlainObject(upstreamValue) && isPlainObject(forkValue)) {
      merged[key] = reconcile(forkValue, upstreamValue, stats)
      continue
    }
    if (forkValue !== undefined && forkValue !== upstreamValue) {
      stats.replaced += 1
    }
    merged[key] = upstreamValue
  }
  for (const [key, forkValue] of Object.entries(fork ?? {})) {
    if (!(key in upstream)) {
      merged[key] = forkValue
      stats.forkOnly += 1
    }
  }
  return merged
}

for (const locale of LOCALES) {
  const file = `src/renderer/src/i18n/locales/${locale}.json`
  const fork = JSON.parse(readFileSync(file, 'utf8'))
  const upstream = JSON.parse(
    execFileSync('git', ['show', `${TARGET}:${file}`], { encoding: 'utf8' })
  )
  const stats = { replaced: 0, forkOnly: 0 }
  writeFileSync(file, `${JSON.stringify(reconcile(fork, upstream, stats), null, 2)}\n`)
  console.log(
    `${locale}: ${stats.replaced} fork values replaced by upstream, ${stats.forkOnly} fork-only keys kept`
  )
}
