# Sandboxed test runs

Runs the suite in throwaway containers, locally or on a remote Docker host. Each shard gets
its own container fed the current working tree over stdin — nothing is mounted from the host,
so shards cannot see each other's temp files, git config, or build output.

## Remote host setup

The remote box needs Docker and an SSH account; the runner drives it over `DOCKER_HOST`, so
nothing but Docker has to be installed there.

```sh
ssh buildbox 'curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER'
docker context create buildbox --docker host=ssh://you@buildbox
```

`--docker-host` defaults to `$ORCA_SANDBOX_DOCKER_HOST`, so set that once instead of passing the
flag on every run. This checkout reads it from `.claude/settings.local.json`, which is machine-local
and untracked — a fresh clone has to set it before the runner reaches anything but the local daemon.

## Running

```sh
# Recommended full unit suite: 16 shards, 2 containers at a time, 2 Vitest workers per container
pnpm test:sandbox --shards=16 --jobs=2 -- --maxWorkers=2

# Higher container concurrency is available when the host has capacity
pnpm test:sandbox --shards=16 --jobs=8

# one shard, reusing the already-built image
pnpm test:sandbox --shards=16 --only=3

# the real-shell lane CI keeps out of the shards
pnpm test:sandbox --lane=shell

# Cross-version wire specs against a locally available baseline (one container)
ORCA_BACKGROUND_LAUNCH=1 pnpm test:sandbox --lane=wire \
  --baseline-ref=v1.4.216-rc.0.zy03 \
  --env ORCA_BACKGROUND_LAUNCH=1 -- \
  tests/e2e/cross-version-wire/fork-heimdall/cross-version-heimdall-wire.unit.test.ts

# Playwright/Electron lane (needs the host Docker socket for the ssh-docker specs)
pnpm test:sandbox --lane=e2e --shards=4 --docker-socket

# extra vitest arguments pass through after --
pnpm test:sandbox --shards=16 --only=1 -- --reporter=verbose
```

The test image needs Git 2.45 or newer with reftable support because
`workflow-ref-reachability.test.mjs` unconditionally runs `git init --ref-format=reftable`.
The image installs Git from the Git Core PPA and verifies reftable support during the image
build; it fails rather than silently falling back if that feature is unavailable. This sandbox
image requirement does not change the product Git baseline.

Shard containers use Docker `--init` so orphaned descendants are reaped before process-exit
assertions. The image also includes `lsof` for real SSH relay socket-holder enumeration.

`--jobs` controls the number of concurrent containers. Vitest worker concurrency is separate;
the recommended full run passes `--maxWorkers=2` to each container after `--`.

The `wire` lane runs the supplied Vitest files without the unit lane's exclusions and requires
`--baseline-ref` to name an explicit local branch or tag. Only that ref is transferred in a
depth-1 bare repository; the source checkout's `.git` directory and credentials are not sent.

Running vitest directly is blocked by a `PreToolUse` hook — see the testing section in
[`AGENTS.md`](../../../AGENTS.md).

Per-shard logs land in `.orca-sandbox-logs/`. `--node=26` builds the second Node version from
the CI matrix.

## Image lifecycle

The image tag is a hash of `package.json`, `pnpm-lock.yaml`, `config/patches`, `config/scripts`,
and this directory, so a dependency bump produces a new tag rather than reusing a stale
dependency tree. Dependencies, the native rebuild, and the Electron binary are baked in, so a
shard starts running tests immediately. If the working tree's lockfile drifts from the image's,
the entrypoint reinstalls before running rather than testing against the wrong tree.

## What the sandbox handles for you

- Unsets inherited `GIT_CONFIG_*`, which otherwise fails the relay agent-exec suites.
- Removes `config/*.tsbuildinfo`, which caches errors across checkouts sharing a tree.
- Sends only non-ignored files, so a stale local `out/` never reaches the container.
- Sets `ORCA_REQUIRE_FISH=1` on the shell lane, so a missing fish fails instead of skipping.
