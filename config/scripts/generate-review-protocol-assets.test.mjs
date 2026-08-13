import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_REVIEW_PROTOCOL_VERSION,
  UPSTREAM_PIN_VERSION,
  UPSTREAM_SCRIPT_SHA256,
  UPSTREAM_SKILL_DIR_SHA256,
  buildArtifacts,
  computeSkillDirHash,
  verifyArtifacts,
  verifyPinDocumentation,
  writeArtifacts
} from './generate-review-protocol-assets.mjs'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
const protocolDir = path.join(projectDir, 'protocol', 'adversarial-review@2026.7.31')
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('review protocol asset generator', () => {
  it('reproduces the known upstream directory hash from the vendored snapshot', async () => {
    expect(await computeSkillDirHash(protocolDir)).toBe(UPSTREAM_SKILL_DIR_SHA256)
  })

  it('reproduces the known upstream script hash from the vendored script', async () => {
    const scriptBytes = await readFile(path.join(protocolDir, 'scripts', 'adversarial-review'))
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(scriptBytes).digest('hex')).toBe(UPSTREAM_SCRIPT_SHA256)
  })

  it('excludes PIN.md from the directory hash computation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const { cp } = await import('node:fs/promises')
    await cp(protocolDir, root, { recursive: true })

    const beforePin = await computeSkillDirHash(root)
    await writeFile(path.join(root, 'PIN.md'), 'mutated pin content that must not affect the hash\n')
    const afterPin = await computeSkillDirHash(root)

    expect(beforePin).toBe(afterPin)
    expect(beforePin).toBe(UPSTREAM_SKILL_DIR_SHA256)
  })

  it('exports the exact pin constants', () => {
    expect(UPSTREAM_PIN_VERSION).toBe('quirk-2026.7.31')
    expect(UPSTREAM_SCRIPT_SHA256).toBe(
      '886e59af7bda5f6741563788ee74d7b7e667f5a5eeea5555859aa6bcd8ea6ba5'
    )
    expect(UPSTREAM_SKILL_DIR_SHA256).toBe(
      '2eaf811a335c9ce7b09167b83b339a9846f78dc6578da23f7a561b51cc5ee858'
    )
    expect(ORCA_REVIEW_PROTOCOL_VERSION).toBe('quirk-2026.7.31+orca.1')
  })

  it('builds deterministic artifacts and verifies the checked-in output', async () => {
    const first = await buildArtifacts(projectDir)
    const second = await buildArtifacts(projectDir)

    expect(second).toEqual(first)
    await expect(verifyArtifacts(first, projectDir)).resolves.toBeUndefined()
  })

  it('embeds every assets/ file under REVIEW_STAGE_PROMPT_ASSETS and profiles/ file under REVIEW_PROFILE_ASSETS', async () => {
    const [{ content }] = await buildArtifacts(projectDir)
    for (const stem of ['composition-contract', 'promote-prompt', 'refute-prompt', 'tiebreak-prompt']) {
      const source = await readFile(path.join(protocolDir, 'assets', `${stem}.md`), 'utf8')
      expect(content).toContain(JSON.stringify(source).slice(0, 40))
    }
    for (const stem of ['code-diff', 'plan', 'prose-claim', 'spec-design']) {
      const source = await readFile(path.join(protocolDir, 'profiles', `${stem}.md`), 'utf8')
      expect(content).toContain(JSON.stringify(source).slice(0, 40))
    }
  })

  it('reports a specific stale-file message and write mode repairs it', async () => {
    const artifacts = await buildArtifacts(projectDir)
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const stalePath = path.join(root, 'src', 'shared', 'review', 'protocol-assets.ts')
    const staleArtifacts = artifacts.map((artifact) => ({ ...artifact, path: stalePath }))

    await expect(verifyArtifacts(staleArtifacts, root)).rejects.toThrow('protocol-assets.ts')
    await writeArtifacts(staleArtifacts)
    await expect(verifyArtifacts(staleArtifacts, root)).resolves.toBeUndefined()
  })

  it('fails fast with a specific message when the vendored script hash drifts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const { cp } = await import('node:fs/promises')
    const tamperedProtocolRoot = path.join(root, 'protocol', 'adversarial-review@2026.7.31')
    await cp(protocolDir, tamperedProtocolRoot, { recursive: true })
    await writeFile(path.join(tamperedProtocolRoot, 'scripts', 'adversarial-review'), '#!/usr/bin/env python3\n')

    await expect(buildArtifacts(root)).rejects.toThrow(/script hash/i)
  })

  it('fails fast with a specific message when the vendored directory hash drifts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const { cp } = await import('node:fs/promises')
    const tamperedProtocolRoot = path.join(root, 'protocol', 'adversarial-review@2026.7.31')
    await cp(protocolDir, tamperedProtocolRoot, { recursive: true })
    await writeFile(path.join(tamperedProtocolRoot, 'assets', 'promote-prompt.md'), 'tampered\n')

    await expect(buildArtifacts(root)).rejects.toThrow(/directory hash/i)
  })

  it('rejects a symlink planted under the vendored tree instead of silently skipping it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const { cp } = await import('node:fs/promises')
    const tamperedProtocolRoot = path.join(root, 'protocol', 'adversarial-review@2026.7.31')
    await cp(protocolDir, tamperedProtocolRoot, { recursive: true })
    const escapeLinkPath = path.join(tamperedProtocolRoot, 'assets', 'escape.md')
    await symlink('/etc/passwd', escapeLinkPath)

    await expect(computeSkillDirHash(tamperedProtocolRoot)).rejects.toThrow(
      new RegExp(escapeLinkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  })

  it('verifies PIN.md documentation against the authoritative constants', async () => {
    await expect(verifyPinDocumentation(protocolDir)).resolves.toBeUndefined()
  })

  it('fails fast with a specific message when PIN.md drifts from a recorded constant', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const { cp } = await import('node:fs/promises')
    const tamperedProtocolRoot = path.join(root, 'protocol', 'adversarial-review@2026.7.31')
    await cp(protocolDir, tamperedProtocolRoot, { recursive: true })
    const pinPath = path.join(tamperedProtocolRoot, 'PIN.md')
    const pinContent = await readFile(pinPath, 'utf8')
    await writeFile(
      pinPath,
      pinContent.replace(
        "UPSTREAM_SCRIPT_SHA256 = '886e59af7bda5f6741563788ee74d7b7e667f5a5eeea5555859aa6bcd8ea6ba5'",
        "UPSTREAM_SCRIPT_SHA256 = '0000000000000000000000000000000000000000000000000000000000000000'"
      )
    )

    await expect(verifyPinDocumentation(tamperedProtocolRoot)).rejects.toThrow(/UPSTREAM_SCRIPT_SHA256/)
  })

  it('tolerates an unrelated prose edit appended to PIN.md', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-review-protocol-assets-'))
    temporaryDirectories.push(root)
    const { cp } = await import('node:fs/promises')
    const tamperedProtocolRoot = path.join(root, 'protocol', 'adversarial-review@2026.7.31')
    await cp(protocolDir, tamperedProtocolRoot, { recursive: true })
    const pinPath = path.join(tamperedProtocolRoot, 'PIN.md')
    await writeFile(pinPath, `${await readFile(pinPath, 'utf8')}\nAn unrelated clarifying sentence.\n`)

    await expect(verifyPinDocumentation(tamperedProtocolRoot)).resolves.toBeUndefined()
  })
})
