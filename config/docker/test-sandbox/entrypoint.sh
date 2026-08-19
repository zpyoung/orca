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

baked="$(cat /opt/orca-sandbox-lockfile.sha256)"
current="$(sha256sum pnpm-lock.yaml | cut -d ' ' -f 1)"
if [ "$baked" != "$current" ]; then
  echo "orca-test-sandbox: lockfile differs from the image; reinstalling" >&2
  pnpm install --no-frozen-lockfile --prefer-frozen-lockfile=false --ignore-scripts
  node config/scripts/ensure-native-runtime.mjs --runtime=node
fi

exec "$@"
