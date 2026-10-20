#!/usr/bin/env bash
set -euo pipefail

# The harness that launches the sandbox leaks GIT_CONFIG_* into it, which
# deterministically fails the relay agent-exec suites.
for name in $(env | sed -n 's/^\(GIT_CONFIG[A-Z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

cd /work

if [ "${ORCA_SANDBOX_SKIP_SOURCE:-0}" != "1" ]; then
  if [ -t 0 ]; then
    echo "orca-test-sandbox: expected a source tar on stdin (run with -i)" >&2
    exit 2
  fi
  tar -x -f -
fi

# Composite tsconfigs cache errors from whichever checkout populated them last.
rm -f config/*.tsbuildinfo

# The source arrives as a plain tar, but suites that shell out to git need a real
# repository. Tree hashes are content-derived, so one synthetic commit satisfies them.
baseline_repository=.orca-sandbox/baseline.git
baseline_ref=refs/orca/cross-version-baseline
baseline_required="${ORCA_SANDBOX_REQUIRE_BASELINE:-0}"

if [ "$baseline_required" = "1" ] && [ "${ORCA_SANDBOX_SKIP_GIT:-0}" = "1" ]; then
  echo "orca-test-sandbox: wire lane requires Git support" >&2
  exit 2
fi
if [ "$baseline_required" = "1" ] && [ ! -d "$baseline_repository" ]; then
  echo "orca-test-sandbox: required baseline repository is missing from the source tar" >&2
  exit 2
fi

if [ "${ORCA_SANDBOX_SKIP_GIT:-0}" != "1" ]; then
  created_git=0
  if [ ! -d .git ]; then
    git init -q .
    created_git=1
  fi

  if [ -d "$baseline_repository" ]; then
    if ! git fetch --quiet --no-tags --update-shallow --depth=1 \
      "$baseline_repository" "$baseline_ref:$baseline_ref"; then
      echo "orca-test-sandbox: could not fetch required baseline ref $baseline_ref" >&2
      exit 2
    fi
    if ! baseline_commit="$(git rev-parse --verify "${baseline_ref}^{commit}")"; then
      echo "orca-test-sandbox: fetched baseline ref $baseline_ref is not a commit" >&2
      exit 2
    fi
    echo "orca-test-sandbox: baseline ref $baseline_ref resolved to $baseline_commit"
    rm -rf "$baseline_repository"
    export ORCA_CROSS_VERSION_BASELINE_REF="$baseline_ref"
  fi

  if [ "$created_git" = "1" ]; then
    git add -A
    git -c user.name=runner -c user.email=runner@sandbox.invalid \
      commit -q -m 'sandbox snapshot' --no-verify
  fi
fi

baked="$(cat /home/runner/lockfile.sha256)"
current="$(sha256sum pnpm-lock.yaml | cut -d ' ' -f 1)"
if [ "$baked" != "$current" ]; then
  echo "orca-test-sandbox: lockfile differs from the image; reinstalling" >&2
  pnpm install --no-frozen-lockfile --no-prefer-frozen-lockfile --ignore-scripts
  node config/scripts/ensure-native-runtime.mjs --runtime=node
fi

exec "$@"
