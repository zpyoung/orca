import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const SANDBOX_BASELINE_REF = 'refs/orca/cross-version-baseline'

/**
 * Appends a shallow, isolated bare repository containing only the requested local ref.
 * The source checkout's .git directory is never copied into the sandbox archive.
 */
export function appendSandboxBaseline(sourceTarPath, requestedRef, projectDir) {
  const sourceRef = resolveLocalRef(projectDir, requestedRef)
  const expectedCommit = runGit(projectDir, ['rev-parse', '--verify', `${sourceRef}^{commit}`])
  const stagingDir = mkdtempSync(path.join(tmpdir(), 'orca-sandbox-baseline-'))
  const bareRepo = path.join(stagingDir, '.orca-sandbox', 'baseline.git')
  mkdirSync(path.dirname(bareRepo), { recursive: true })

  try {
    runGit(projectDir, ['init', '--bare', '--quiet', '--template=', bareRepo])
    runGit(projectDir, [
      `--git-dir=${bareRepo}`,
      'fetch',
      '--depth=1',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      projectDir,
      `+${sourceRef}:${SANDBOX_BASELINE_REF}`
    ])

    const fetchedCommit = runGit(projectDir, [
      `--git-dir=${bareRepo}`,
      'rev-parse',
      '--verify',
      `${SANDBOX_BASELINE_REF}^{commit}`
    ])
    if (fetchedCommit !== expectedCommit) {
      throw new Error(
        `baseline ref "${requestedRef}" changed while preparing the sandbox ` +
          `(${expectedCommit} became ${fetchedCommit})`
      )
    }

    const append = spawnSync(
      'tar',
      ['-r', '--format=ustar', '-f', sourceTarPath, '-C', stagingDir, '.orca-sandbox/baseline.git'],
      {
        encoding: 'utf8',
        env: { ...process.env, COPYFILE_DISABLE: '1' }
      }
    )
    if (append.status !== 0) {
      const detail = (append.stderr || append.error?.message || '').trim()
      throw new Error(`could not append the shallow baseline repository: ${detail}`)
    }

    return { sourceRef, commit: fetchedCommit }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

function resolveLocalRef(projectDir, requestedRef) {
  if (
    typeof requestedRef !== 'string' ||
    requestedRef.length === 0 ||
    requestedRef.trim() !== requestedRef
  ) {
    throw new Error('--baseline-ref must name an explicit local Git ref')
  }

  const candidates = requestedRef.startsWith('refs/')
    ? [requestedRef]
    : [`refs/tags/${requestedRef}`, `refs/heads/${requestedRef}`]
  const present = []
  for (const candidate of candidates) {
    const format = spawnSync('git', ['check-ref-format', candidate], {
      cwd: projectDir,
      encoding: 'utf8'
    })
    if (format.status !== 0) {
      throw new Error(`invalid local baseline ref "${requestedRef}"`)
    }

    const probe = spawnSync('git', ['show-ref', '--verify', '--quiet', candidate], {
      cwd: projectDir,
      encoding: 'utf8'
    })
    if (probe.status === 0) {
      present.push(candidate)
    } else if (probe.status !== 1) {
      const detail = (probe.stderr || probe.error?.message || '').trim()
      throw new Error(`could not inspect local baseline ref "${requestedRef}": ${detail}`)
    }
  }

  if (present.length === 0) {
    throw new Error(`baseline ref "${requestedRef}" does not exist locally in ${projectDir}`)
  }
  if (present.length > 1) {
    throw new Error(
      `baseline ref "${requestedRef}" is ambiguous; use one of: ${present.join(', ')}`
    )
  }
  return present[0]
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.error?.message || 'git command failed').trim())
  }
  return result.stdout.trim()
}
