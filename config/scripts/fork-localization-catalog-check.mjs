#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import {
  collectGenericTermRegressions,
  collectLocalizationKeyReferences,
  main as verifyUpstreamLocalizationCatalog
} from './verify-localization-catalog.mjs'
import { main as verifyUpstreamLocalizationExtraction } from './verify-localization-extraction.mjs'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['.git', 'dist', 'node_modules', 'out', '__snapshots__', 'assets'])
const LOCALES_RELATIVE_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const SOURCE_RELATIVE_ROOTS = [path.join('src', 'renderer', 'src'), path.join('src', 'main')]

function flattenEntries(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flattenEntries(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

function setEntry(catalog, key, value) {
  const parts = key.split('.')
  let cursor = catalog
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

function mergeCatalog(target, addition) {
  for (const [key, value] of Object.entries(addition)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const targetValue = target[key]
      if (typeof targetValue !== 'object' || targetValue === null || Array.isArray(targetValue)) {
        target[key] = {}
      }
      mergeCatalog(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

function collectInterpolationVariables(value) {
  return typeof value === 'string' ? [...(value.match(/\{\{[^}]+\}\}/g) ?? [])].sort() : []
}

function catalogParityIssues(enCatalog, localeCatalog) {
  const english = flattenEntries(enCatalog)
  const locale = flattenEntries(localeCatalog)
  const missing = [...english.keys()].filter((key) => !locale.has(key))
  const extra = [...locale.keys()].filter((key) => !english.has(key))
  const interpolation = [...english.keys()].filter(
    (key) =>
      locale.has(key) &&
      collectInterpolationVariables(english.get(key)).join('|') !==
        collectInterpolationVariables(locale.get(key)).join('|')
  )
  return { english, locale, missing, extra, interpolation }
}

function isSourceFile(filePath) {
  return (
    SOURCE_EXTENSIONS.has(path.extname(filePath)) && !/\.d\.ts$|\.test\.|\.spec\./.test(filePath)
  )
}

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (SKIP_PATH_PARTS.has(entry.name)) {
      continue
    }
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(filePath)))
    } else if (entry.isFile() && isSourceFile(filePath)) {
      files.push(filePath)
    }
  }
  return files
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function discoverForkCatalogs(root) {
  const rendererRoot = path.join(root, 'src', 'renderer', 'src')
  const catalogs = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_PATH_PARTS.has(entry.name)) {
        continue
      }
      const filePath = path.join(dir, entry.name)
      if (!entry.isDirectory()) {
        continue
      }
      if (entry.name.startsWith('fork-')) {
        const localesDir = path.join(filePath, 'locales')
        try {
          const localeFiles = (await fs.readdir(localesDir)).filter((name) =>
            name.endsWith('.json')
          )
          if (localeFiles.length > 0) {
            catalogs.push({ featureDir: filePath, localesDir, localeFiles })
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error
          }
        }
      }
      await walk(filePath)
    }
  }
  await walk(rendererRoot)
  return catalogs
}

function parseArgs(argv) {
  return { fix: argv.includes('--fix'), verifyExtraction: argv.includes('--verify-extraction') }
}

/** Validate feature bundles with the same missing-key, parity, interpolation,
 * and translated-generic-term rules as the upstream catalog verifier. */
export async function validateForkLocalizationCatalogs(root = process.cwd(), options = {}) {
  const upstreamLocalesDir = path.join(root, LOCALES_RELATIVE_DIR)
  const localeNames = (await fs.readdir(upstreamLocalesDir))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
  const bundles = await discoverForkCatalogs(root)
  let failed = false
  const englishByKey = new Map()

  for (const bundle of bundles) {
    if (!bundle.localeFiles.includes('en.json')) {
      console.error(`Fork catalog ${path.relative(root, bundle.localesDir)} is missing en.json.`)
      failed = true
      continue
    }
    const english = await readJson(path.join(bundle.localesDir, 'en.json'))
    for (const [key, value] of flattenEntries(english)) {
      englishByKey.set(key, value)
    }
    for (const locale of localeNames.filter((name) => name !== 'en')) {
      const localeFile = `${locale}.json`
      if (!bundle.localeFiles.includes(localeFile)) {
        console.error(
          `Fork catalog ${path.relative(root, bundle.localesDir)} is missing ${localeFile}.`
        )
        failed = true
        continue
      }
      const target = await readJson(path.join(bundle.localesDir, localeFile))
      const {
        english: englishEntries,
        locale: localeEntries,
        extra,
        interpolation
      } = catalogParityIssues(english, target)
      const generic = collectGenericTermRegressions(englishEntries, localeEntries, locale)
      if (extra.length || interpolation.length || generic.length) {
        console.error(
          `Fork locale catalog validation failed for ${path.relative(root, path.join(bundle.localesDir, localeFile))}.`
        )
        for (const key of extra) {
          console.error(`extra: ${key}`)
        }
        for (const key of interpolation) {
          console.error(`interpolation mismatch: ${key}`)
        }
        for (const entry of generic) {
          console.error(`generic term regression: ${entry.key}`)
        }
        failed = true
      }
    }
  }

  const references = []
  for (const relativeRoot of SOURCE_RELATIVE_ROOTS) {
    const sourceRoot = path.join(root, relativeRoot)
    for (const filePath of await collectFiles(sourceRoot)) {
      references.push(
        ...collectLocalizationKeyReferences(filePath, await fs.readFile(filePath, 'utf8'), root)
      )
    }
  }
  const upstreamEnglish = await readJson(path.join(upstreamLocalesDir, 'en.json'))
  const knownKeys = new Set([...flattenEntries(upstreamEnglish).keys(), ...englishByKey.keys()])
  const missing = references.filter((reference) => !knownKeys.has(reference.key))
  const noFallback = missing.filter((reference) => typeof reference.fallback !== 'string')
  if (noFallback.length > 0) {
    console.error('Fork localization keys are missing string fallbacks.')
    for (const reference of noFallback) {
      console.error(`${reference.filePath}:${reference.line} ${reference.key}`)
    }
    failed = true
  }
  if (missing.length > 0 && !options.fix) {
    console.error('Localization keys are missing from upstream and fork English catalogs.')
    for (const reference of missing) {
      console.error(`${reference.filePath}:${reference.line} ${reference.key}`)
    }
    failed = true
  }
  if (missing.length > 0 && options.fix && noFallback.length === 0) {
    for (const reference of missing) {
      const absolute = path.join(root, reference.filePath)
      const owner = bundles.find((bundle) => absolute.startsWith(`${bundle.featureDir}${path.sep}`))
      if (!owner) {
        console.error(
          `Cannot assign ${reference.key} to a fork catalog from ${reference.filePath}.`
        )
        failed = true
        continue
      }
      const englishPath = path.join(owner.localesDir, 'en.json')
      const english = await readJson(englishPath)
      setEntry(english, reference.key, reference.fallback)
      await fs.writeFile(englishPath, `${JSON.stringify(english, null, 2)}\n`)
    }
  }
  return failed ? 1 : 0
}

async function runUpstreamVerifierWithForkCatalogs(root, options, verify) {
  const localesDir = path.join(root, LOCALES_RELATIVE_DIR)
  const bundleDirectories = await discoverForkCatalogs(root)
  const originals = new Map()
  const localeNames = (await fs.readdir(localesDir))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => name.slice(0, -'.json'.length))
  for (const locale of localeNames) {
    const filePath = path.join(localesDir, `${locale}.json`)
    const text = await fs.readFile(filePath, 'utf8')
    const catalog = JSON.parse(text)
    originals.set(locale, { text, catalog })
    const merged = structuredClone(catalog)
    for (const bundle of bundleDirectories) {
      const bundlePath = path.join(bundle.localesDir, `${locale}.json`)
      mergeCatalog(merged, await readJson(bundlePath))
    }
    await fs.writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`)
  }
  try {
    return await verify(root, options)
  } finally {
    for (const locale of localeNames) {
      const original = originals.get(locale)
      // a locale merged before an earlier iteration threw was never written; restoring it here
      // would throw inside `finally` and replace the real error
      if (!original) {
        continue
      }
      const filePath = path.join(localesDir, `${locale}.json`)
      await fs.writeFile(filePath, original.text)
    }
  }
}

export async function main(root = process.cwd(), options = parseArgs(process.argv.slice(2))) {
  const forkResult = await validateForkLocalizationCatalogs(root, options)
  if (forkResult !== 0) {
    return forkResult
  }
  const verify = options.verifyExtraction
    ? (verificationRoot) => verifyUpstreamLocalizationExtraction(verificationRoot)
    : verifyUpstreamLocalizationCatalog
  return runUpstreamVerifierWithForkCatalogs(root, options, verify)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
