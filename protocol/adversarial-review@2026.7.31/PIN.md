# Pin: adversarial-review @ quirk 2026.7.31

This directory is a byte-for-byte vendored snapshot of the upstream `quirk`
plugin's `adversarial-review` skill, pinned at release `2026.7.31`. It is
vendor-and-forget: Orca-owned from day one, with no upstream sync mechanism.
A future re-pin to a newer upstream release is a **new** vendored directory
(e.g. `protocol/adversarial-review@2026.X.Y/`) plus a protocol-version bump —
never an update-in-place of this one.

The vendored Python script (`scripts/adversarial-review`) is never executed
at runtime and is never packaged; it exists here as provenance and as a test
fixture for the embedding generator.

## Pin constants

- `UPSTREAM_PIN_VERSION = 'quirk-2026.7.31'`
- `UPSTREAM_SCRIPT_SHA256 = '886e59af7bda5f6741563788ee74d7b7e667f5a5eeea5555859aa6bcd8ea6ba5'`
- `UPSTREAM_SKILL_DIR_SHA256 = '2eaf811a335c9ce7b09167b83b339a9846f78dc6578da23f7a561b51cc5ee858'`
- `ORCA_REVIEW_PROTOCOL_VERSION = 'quirk-2026.7.31+orca.1'`

`UPSTREAM_SKILL_DIR_SHA256` covers the 10 files vendored from upstream and
excludes this file (`PIN.md` is Orca-added provenance, not part of the
upstream snapshot).
