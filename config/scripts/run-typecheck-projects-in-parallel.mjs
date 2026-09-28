import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

// These projects overlap heavily in src/shared but have no build dependency on
// each other, so tsc can check them concurrently instead of in a `&&` chain.
// Why node and web sit in separate waves: each peaks near 10 GB, and together they
// get the 16 GB ubuntu-latest runner OOM-killed mid-check.
const waves = [
  ['tsconfig.node.json', 'tsconfig.tc.cli.json', 'tsconfig.mobile-web.json'],
  ['tsconfig.tc.web.json']
]
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

// Why serialize on a single-core runner: three tsc processes there thrash rather than overlap.
const concurrent = availableParallelism() > 1

function checkProject(project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '--noEmit', '-p', `config/${project}`], {
      cwd: repoRoot,
      stdio: 'inherit'
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`tsc ${project} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`tsc ${project} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

const failures = []
if (concurrent) {
  for (const wave of waves) {
    const results = await Promise.allSettled(wave.map(checkProject))
    failures.push(
      ...results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    )
  }
} else {
  for (const project of waves.flat()) {
    try {
      await checkProject(project)
    } catch (error) {
      failures.push(error)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message ?? failure)
  }
  process.exit(1)
}
