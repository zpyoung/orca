// The deterministic stub agent. `agentCmdOverrides` points a real TuiAgent id at
// `node <this file> <controlDir>`; the real launch machinery appends the prompt as the
// final argv token afterward (see stub-agent-launcher.ts), so this never runs standalone —
// it is always spawned as a shell command line inside the agent's PTY.
//
// Everything it does is driven by a per-invocation script the test writes into <controlDir>
// beforehand: which files to write, whether to stage/commit, whether to hold at a named
// boundary, and the outcome to report. Every observable action is a file this script writes
// into <controlDir>, so a test can assert on exactly what the "agent" received and did
// without any real AI in the loop.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const HOLD_POLL_MS = 20
const HOLD_TIMEOUT_MS = 5 * 60 * 1000
const SCRIPT_WAIT_TIMEOUT_MS = 2000
const SCRIPT_WAIT_POLL_MS = 20

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function controlFile(controlDir, name) {
  return path.join(controlDir, name)
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value))
}

// Why a claim file per index rather than a shared counter: exclusive create (`wx`) is
// atomic across processes with no separate lock file, and the sequence it produces is
// exactly dispatch order — the property every "attempt 1 fails, attempt 2 succeeds"
// script in the acceptance suite depends on.
function claimInvocationIndex(controlDir) {
  for (let index = 0; ; index += 1) {
    const claimPath = controlFile(controlDir, `${index}.claimed`)
    try {
      fs.closeSync(fs.openSync(claimPath, 'wx'))
      return index
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }
  }
}

function readScript(controlDir, index) {
  const scriptPath = controlFile(controlDir, `${index}.script.json`)
  const deadline = Date.now() + SCRIPT_WAIT_TIMEOUT_MS
  for (;;) {
    if (fs.existsSync(scriptPath)) {
      return JSON.parse(fs.readFileSync(scriptPath, 'utf8'))
    }
    if (Date.now() >= deadline) {
      throw new Error(`No script found at ${scriptPath} within ${SCRIPT_WAIT_TIMEOUT_MS}ms`)
    }
    sleepSync(SCRIPT_WAIT_POLL_MS)
  }
}

function writeScriptedFiles(cwd, files) {
  const staged = []
  for (const file of files ?? []) {
    const target = path.join(cwd, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content)
    if (file.stage) {
      staged.push(file.path)
    }
  }
  return staged
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.status}`)
  }
}

function holdUntilReleased(controlDir, index, boundary) {
  fs.writeFileSync(controlFile(controlDir, `${index}.holding-${boundary}`), '')
  const releasePath = controlFile(controlDir, `${index}.release-${boundary}`)
  const deadline = Date.now() + HOLD_TIMEOUT_MS
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Hold at boundary "${boundary}" was never released within ${HOLD_TIMEOUT_MS}ms`)
    }
    sleepSync(HOLD_POLL_MS)
  }
}

function main() {
  const controlDir = process.argv[2]
  const prompt = process.argv.at(-1)
  if (!controlDir || process.argv.length < 4) {
    process.stderr.write('stub-agent-runner: expected <controlDir> ... <prompt>\n')
    process.exit(2)
  }

  const index = claimInvocationIndex(controlDir)
  fs.writeFileSync(controlFile(controlDir, `${index}.received-prompt.txt`), prompt)
  writeJson(controlFile(controlDir, `${index}.received-argv.json`), process.argv.slice(2))

  try {
    const script = readScript(controlDir, index)
    const cwd = process.cwd()
    const staged = writeScriptedFiles(cwd, script.files)
    if (staged.length > 0) {
      runGit(cwd, ['add', ...staged])
    }
    if (script.commit) {
      runGit(cwd, ['commit', '-m', script.commit])
    }
    if (script.holdAt) {
      holdUntilReleased(controlDir, index, script.holdAt)
    }

    writeJson(controlFile(controlDir, `${index}.outcome.json`), {
      index,
      outcome: script.outcome,
      message: script.failureMessage ?? null
    })
    process.exitCode = script.outcome === 'success' ? 0 : 1
  } catch (error) {
    writeJson(controlFile(controlDir, `${index}.error.json`), {
      index,
      message: error instanceof Error ? error.message : String(error)
    })
    process.exitCode = 3
  }
}

main()
