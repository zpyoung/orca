import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcessSync } from '@orca/process-host'

function git(root, args) {
  const result = runProcessSync({ program: 'git', args, cwd: root })
  if (result.code !== 0 || result.outputTruncated) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Whether the baseline commit has no copy of the benchmarked script.
 *
 * A sync PR adds scripts that its first parent (the fork's main) never had, so there is nothing
 * to compare them with. That is reported and recorded, not failed; a baseline that exists is never
 * skipped, and a git error still throws.
 */
export function announceMissingBaseline({ root, output, comparison, ref, file }) {
  if (git(root, ['ls-tree', '--name-only', ref, '--', file]) !== '') {
    return false
  }
  const sha = git(root, ['rev-parse', `${ref}^{commit}`])
  const message = `No baseline at ${sha}: ${file} is new in this PR, so ${comparison} has nothing to compare against.`
  console.log(`::notice title=No benchmark baseline::${message}`)
  console.log(message)
  mkdirSync(output, { recursive: true })
  writeFileSync(
    path.join(output, `no-baseline-${comparison}.json`),
    `${JSON.stringify({ comparison, baselineSha: sha, file, reason: message }, null, 2)}\n`
  )
  return true
}

/**
 * Clears `out/` before a timed smoke run, keeping the mobile web bundle: orcad refuses to build
 * without it, and building it is not part of what the smoke comparison measures.
 */
export function clearBuildOutputKeepingMobileWeb(root) {
  const output = path.join(root, 'out')
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.name !== 'mobile-web') {
      rmSync(path.join(output, entry.name), { recursive: true, force: true })
    }
  }
}
