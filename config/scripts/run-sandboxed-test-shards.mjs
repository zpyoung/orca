#!/usr/bin/env node

/**
 * Runs the test suite in throwaway containers, optionally on a remote Docker host.
 *
 * Each shard gets its own container built from config/docker/test-sandbox, fed the
 * current working tree over stdin. Nothing is mounted from the host, so a shard
 * cannot see another shard's temp files, git config, or build output.
 *
 * Usage:
 *   node config/scripts/run-sandboxed-test-shards.mjs [options] [-- extra vitest args]
 *
 * Options:
 *   --lane=unit|shell|e2e   Which suite to run (default: unit)
 *   --shards=N              Shard count for the unit and e2e lanes (default: 16)
 *   --jobs=N                Containers to run concurrently (default: shards)
 *   --only=1,4,9            Run just these shard numbers
 *   --node=24               Node major version baked into the image (default: 24)
 *   --docker-host=URL       Docker endpoint, e.g. ssh://user@buildbox
 *   --docker-socket         Mount the host Docker socket (git-compat and ssh e2e lanes)
 *   --logs=DIR              Where to write per-shard logs (default: .orca-sandbox-logs)
 *   --env KEY=VALUE         Extra environment variable for every shard (repeatable)
 *   --rebuild               Rebuild the image even if the tag already exists
 *   --keep-failed           Leave failed containers behind for inspection
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const PROJECT_DIR = path.resolve(import.meta.dirname, '../..')

/** Files the image build needs; everything else reaches the container at run time. */
const IMAGE_CONTEXT_ROOTS = [
  '.npmrc',
  'config/docker/test-sandbox',
  'config/patches',
  'config/scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml'
]

/**
 * Specs pr.yml keeps out of the sharded lane because they drive real shells at
 * maxWorkers=1. Kept identical so a sandbox run covers exactly what CI covers.
 */
const SHELL_CONTRACT_SPECS = [
  'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
  'src/main/daemon/shell-ready.test.ts',
  'src/main/daemon/node-pty-fd-leak.test.ts',
  'src/main/providers/local-pty-shell-ready.test.ts',
  'src/main/providers/__tests__/shell-ready-framework-example.test.ts',
  'src/main/pty/omp-shell-wrapper.node-pty.test.ts',
  'src/renderer/src/components/terminal-pane/fish-color-scheme-child-stdin.node-pty.test.ts',
  'src/shared/posix-command-path-lookup.test.ts'
]

const UNIT_EXCLUDES = [...SHELL_CONTRACT_SPECS, 'tests/e2e/cross-version-wire/**']

const LANES = new Set(['unit', 'shell', 'e2e'])

main()

function main() {
  const options = readOptions()
  const dockerEnv = options.dockerHost
    ? { ...process.env, DOCKER_HOST: options.dockerHost }
    : process.env

  requireDocker(dockerEnv)

  const imageTag = `orca-test-sandbox:${computeImageDigest(options.nodeMajor)}`
  if (options.rebuild || !imageExists(imageTag, dockerEnv)) {
    buildImage(imageTag, options, dockerEnv)
  } else {
    console.log(`Reusing image ${imageTag}`)
  }

  const sourceTarPath = createSourceTar()
  mkdirSync(options.logsDir, { recursive: true })

  const shards = resolveShards(options)
  console.log(
    `Running lane "${options.lane}" as ${shards.length} shard(s), ${options.jobs} at a time` +
      `${options.dockerHost ? ` on ${options.dockerHost}` : ''}`
  )

  runShards({ shards, options, imageTag, sourceTarPath, dockerEnv })
    .then((results) => {
      rmSync(path.dirname(sourceTarPath), { recursive: true, force: true })
      report(results, options.logsDir)
      process.exit(results.some((result) => result.code !== 0) ? 1 : 0)
    })
    .catch((error) => {
      rmSync(path.dirname(sourceTarPath), { recursive: true, force: true })
      console.error(error)
      process.exit(1)
    })
}

function readOptions() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      lane: { type: 'string', default: 'unit' },
      shards: { type: 'string', default: '16' },
      jobs: { type: 'string' },
      only: { type: 'string' },
      node: { type: 'string', default: '24' },
      'docker-host': { type: 'string' },
      'docker-socket': { type: 'boolean', default: false },
      logs: { type: 'string', default: '.orca-sandbox-logs' },
      env: { type: 'string', multiple: true, default: [] },
      rebuild: { type: 'boolean', default: false },
      'keep-failed': { type: 'boolean', default: false }
    }
  })

  if (!LANES.has(values.lane)) {
    fail(`--lane must be one of ${[...LANES].join(', ')}`)
  }

  const shardTotal = values.lane === 'shell' ? 1 : readPositiveInteger(values.shards, '--shards')
  const jobs = values.jobs ? readPositiveInteger(values.jobs, '--jobs') : shardTotal

  return {
    lane: values.lane,
    shardTotal,
    jobs: Math.min(jobs, shardTotal),
    only: values.only
      ? values.only.split(',').map((entry) => readPositiveInteger(entry, '--only'))
      : null,
    nodeMajor: readPositiveInteger(values.node, '--node'),
    dockerHost: values['docker-host'] ?? null,
    mountDockerSocket: values['docker-socket'],
    logsDir: path.resolve(PROJECT_DIR, values.logs),
    extraEnv: values.env.map(readEnvPair),
    rebuild: values.rebuild,
    keepFailed: values['keep-failed'],
    extraArgs: positionals
  }
}

function readPositiveInteger(raw, flag) {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer, got "${raw}"`)
  }
  return parsed
}

function readEnvPair(raw) {
  const separator = raw.indexOf('=')
  if (separator < 1) {
    fail(`--env expects KEY=VALUE, got "${raw}"`)
  }
  return raw
}

function requireDocker(dockerEnv) {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    env: dockerEnv
  })
  if (probe.status !== 0) {
    fail(`cannot reach the Docker daemon: ${(probe.stderr || probe.error?.message || '').trim()}`)
  }
  console.log(`Docker daemon ${probe.stdout.trim()}`)
}

/** Tags the image by its inputs so a dependency bump cannot be tested against a stale tree. */
function computeImageDigest(nodeMajor) {
  const hash = createHash('sha256')
  hash.update(`node:${nodeMajor}\0`)
  for (const file of listContextFiles()) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(path.join(PROJECT_DIR, file)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

function listContextFiles() {
  return trackedFiles().filter((file) =>
    IMAGE_CONTEXT_ROOTS.some((root) => file === root || file.startsWith(`${root}/`))
  )
}

/**
 * Tracked plus untracked-but-not-ignored files, so uncommitted work is what runs.
 * Ignoring gitignored paths is what keeps a stale local out/ from reaching the sandbox.
 */
function trackedFiles() {
  const listing = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )
  if (listing.status !== 0) {
    fail(`git ls-files failed: ${(listing.stderr || '').trim()}`)
  }
  return listing.stdout
    .split('\0')
    .filter((file) => file.length > 0 && existsSync(path.join(PROJECT_DIR, file)))
}

function imageExists(imageTag, dockerEnv) {
  const probe = spawnSync('docker', ['image', 'inspect', imageTag], {
    stdio: 'ignore',
    env: dockerEnv
  })
  return probe.status === 0
}

function buildImage(imageTag, options, dockerEnv) {
  console.log(`Building ${imageTag} (node ${options.nodeMajor})`)
  const contextTar = writeTar(listContextFiles(), 'orca-sandbox-context-')
  addRootDockerfile(contextTar)
  const stdin = openSync(contextTar, 'r')
  const build = spawnSync(
    'docker',
    ['build', '--tag', imageTag, '--build-arg', `NODE_MAJOR=${options.nodeMajor}`, '-'],
    { stdio: [stdin, 'inherit', 'inherit'], env: dockerEnv }
  )
  rmSync(path.dirname(contextTar), { recursive: true, force: true })
  if (build.status !== 0) {
    fail('image build failed')
  }
}

/**
 * Copies the Dockerfile to the context root so `docker build -` finds it by default,
 * because --file against a stdin context is what makes buildx misread the archive.
 */
function addRootDockerfile(tarPath) {
  const stagingDir = path.dirname(tarPath)
  copyFileSync(
    path.join(PROJECT_DIR, 'config/docker/test-sandbox/Dockerfile'),
    path.join(stagingDir, 'Dockerfile')
  )
  const append = spawnSync(
    'tar',
    ['-r', '--format', 'ustar', '-f', tarPath, '-C', stagingDir, 'Dockerfile'],
    {
      encoding: 'utf8',
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    }
  )
  if (append.status !== 0) {
    fail(`could not add the Dockerfile to the build context: ${(append.stderr || '').trim()}`)
  }
}

function createSourceTar() {
  return writeTar(trackedFiles(), 'orca-sandbox-source-')
}

function writeTar(files, prefix) {
  const stagingDir = mkdtempSync(path.join(tmpdir(), prefix))
  const listPath = path.join(stagingDir, 'files.txt')
  const tarPath = path.join(stagingDir, 'context.tar')
  writeFileSync(listPath, `${files.join('\0')}\0`)
  const archive = spawnSync(
    'tar',
    ['-c', '--format', 'ustar', '-f', tarPath, '--null', '-T', listPath],
    {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      // Otherwise bsdtar stores xattrs as AppleDouble entries that extract on Linux as
      // real ._ files, and Vitest collects every ._*.test.ts as an unparseable suite.
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    }
  )
  if (archive.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true })
    fail(`tar failed: ${(archive.stderr || '').trim()}`)
  }
  return tarPath
}

function resolveShards(options) {
  const all = Array.from({ length: options.shardTotal }, (_, index) => index + 1)
  if (!options.only) {
    return all
  }
  const invalid = options.only.filter((shard) => shard > options.shardTotal)
  if (invalid.length > 0) {
    fail(`--only refers to shard(s) beyond --shards=${options.shardTotal}: ${invalid.join(', ')}`)
  }
  return options.only
}

async function runShards({ shards, options, imageTag, sourceTarPath, dockerEnv }) {
  const results = []
  const queue = [...shards]
  const workers = Array.from({ length: options.jobs }, async () => {
    while (queue.length > 0) {
      const shard = queue.shift()
      results.push(await runShard({ shard, options, imageTag, sourceTarPath, dockerEnv }))
    }
  })
  await Promise.all(workers)
  return results.sort((left, right) => left.shard - right.shard)
}

function runShard({ shard, options, imageTag, sourceTarPath, dockerEnv }) {
  const containerName = `orca-test-${options.lane}-${shard}-${process.pid}`
  const logPath = path.join(options.logsDir, `${options.lane}-shard-${shard}.log`)
  const logFd = openSync(logPath, 'w')
  const startedAt = Date.now()

  const dockerArgs = [
    'run',
    '--interactive',
    ...(options.keepFailed ? ['--name', containerName] : ['--rm']),
    ...laneEnvArgs(options.lane),
    ...options.extraEnv.flatMap((pair) => ['--env', pair]),
    ...(options.mountDockerSocket ? ['--volume', '/var/run/docker.sock:/var/run/docker.sock'] : []),
    imageTag,
    ...laneCommand(options, shard)
  ]

  return new Promise((resolve) => {
    const child = spawn('docker', dockerArgs, {
      stdio: [openSync(sourceTarPath, 'r'), logFd, logFd],
      env: dockerEnv
    })
    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt
      console.log(
        `${code === 0 ? 'pass' : 'FAIL'}  shard ${shard}/${options.shardTotal}  ` +
          `${formatDuration(durationMs)}  ${path.relative(PROJECT_DIR, logPath)}`
      )
      resolve({ shard, code: code ?? 1, durationMs, logPath })
    })
  })
}

function laneEnvArgs(lane) {
  if (lane === 'shell') {
    // Otherwise the fish tests skip themselves and the lane reports green having run nothing.
    return ['--env', 'ORCA_REQUIRE_FISH=1']
  }
  if (lane === 'e2e') {
    return ['--env', 'ORCA_E2E_FORWARD_APP_LOGS=1', '--env', 'ORCA_E2E_WEB_CLIENT=1']
  }
  return []
}

function laneCommand(options, shard) {
  if (options.lane === 'shell') {
    return [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'config/vitest.config.ts',
      '--maxWorkers=1',
      ...SHELL_CONTRACT_SPECS,
      ...options.extraArgs
    ]
  }

  if (options.lane === 'e2e') {
    return [
      'xvfb-run',
      '--auto-servernum',
      'pnpm',
      'run',
      'test:e2e',
      `--shard=${shard}/${options.shardTotal}`,
      ...options.extraArgs
    ]
  }

  return [
    'pnpm',
    'exec',
    'vitest',
    'run',
    '--config',
    'config/vitest.config.ts',
    ...UNIT_EXCLUDES.map((spec) => `--exclude=${spec}`),
    `--shard=${shard}/${options.shardTotal}`,
    ...options.extraArgs
  ]
}

function report(results, logsDir) {
  const failures = results.filter((result) => result.code !== 0)
  const slowest = [...results].sort((left, right) => right.durationMs - left.durationMs)[0]
  console.log('')
  console.log(`${results.length - failures.length}/${results.length} shard(s) passed`)
  if (slowest) {
    console.log(`slowest shard ${slowest.shard} at ${formatDuration(slowest.durationMs)}`)
  }
  if (failures.length > 0) {
    console.log(`failed shard(s): ${failures.map((result) => result.shard).join(', ')}`)
    console.log(`logs: ${path.relative(PROJECT_DIR, logsDir)}`)
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000)
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`
}

function fail(message) {
  console.error(`run-sandboxed-test-shards: ${message}`)
  process.exit(2)
}
