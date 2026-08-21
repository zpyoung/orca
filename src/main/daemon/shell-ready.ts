import { tmpdir } from 'node:os'
import { basename, join, win32 as pathWin32 } from 'node:path'
import { statSync } from 'node:fs'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap,
  isPowerShellExecutableName
} from '../powershell-osc133-bootstrap'
import { getFishCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { getFishShellReadyInitCommand } from '../shell-templates'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight
} from '../pty/codex-shell-launch-preflight'
import {
  getFishShellReadyInitCommand,
  getZshEnvTemplate,
  getZshFinalZdotdirRestoreBlock,
  getZshShellReadyMarkerRegistrationBlock,
  SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
  getZshStartupFileSourceBlock
} from '../shell-templates'

const ORCA_USER_DATA_PATH_ENV = 'ORCA_USER_DATA_PATH'

function getShellReadyWrapperBaseDir(): string {
  const userDataPath = process.env[ORCA_USER_DATA_PATH_ENV]
  // Why a base dir of its own rather than the legacy `shell-ready/`: daemons of
  // older builds still write that path unconditionally, so leaving it to them
  // keeps this build's content-addressed trees out of their reach.
  // Why the tmpdir fallback: older/test launchers may not seed
  // ORCA_USER_DATA_PATH, and daemon startup must not fail before the parent can
  // be fixed. It is dev/test-only -- daemon-init always passes the real path --
  // which matters because the presence check is size-only, so a complete tree
  // pre-planted under a shared /tmp would be trusted rather than overwritten.
  return join(userDataPath || tmpdir(), userDataPath ? 'shell-wrappers' : 'orca-shell-wrappers')
}

// Why memoized and keyed on the base dir: the digest is stable for a given base
// dir, every shell launch asks for it, and the key self-invalidates if
// ORCA_USER_DATA_PATH is ever re-pointed mid-process.
let cachedShellReadyWrapperRoot: { baseDir: string; root: string } | null = null

export function getShellReadyWrapperRoot(): string {
  const baseDir = getShellReadyWrapperBaseDir()
  if (cachedShellReadyWrapperRoot?.baseDir !== baseDir) {
    cachedShellReadyWrapperRoot = {
      baseDir,
      root: resolveShellWrapperRoot(baseDir, buildDaemonShellReadyWrapperFiles)
    }
  }
  return cachedShellReadyWrapperRoot.root
}

function getRequiredShellReadyWrapperPaths(root = getShellReadyWrapperRoot()): string[] {
  return buildDaemonShellReadyWrapperFiles(root).map(([path]) => path)
}

// Why non-empty and not just present: a partial write leaves a zero-byte
// .zshenv, and pointing ZDOTDIR at that dir makes zsh skip the user's config.
function shellReadyWrappersExist(): boolean {
  return getRequiredShellReadyWrapperPaths().every((path) => existsSync(path))
}

export function getDaemonBashShellReadyRcfileContent(): string {
  return `# Orca daemon bash shell-ready wrapper
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so Orca can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~); without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__orca_restore_agent_teams_path
# Why: user startup files may set the default OpenCode config after Orca's
# spawn env; restore the Orca-managed config dir before the first prompt.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
${getPosixOmpShellWrapper()}
# Why: Codex must keep using Orca's runtime CODEX_HOME after profile scripts.
[[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight()}
# Why: emit OSC 133 C/D so terminal-command-lifecycle can drop stale agent
# status when the foreground command exits — mirrors the zsh daemon wrapper.
# Without this, bash users (default on most Linux distros) keep a stuck
# 'working' spinner after the CLI exits without a Stop/SessionEnd hook.
__orca_osc133_precmd() {
  local exit_code=$?
  __orca_in_prompt_command=1
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
  # Why: emit the shell-ready marker here (not a trailing PROMPT_COMMAND entry)
  # so a framework that must be last in PROMPT_COMMAND — bash-preexec — is not
  # displaced by one of Orca's own hooks.
  [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]] && printf "${SHELL_READY_MARKER}"
}
__orca_run_user_debug_trap() {
  if [[ -n "\${__orca_user_debug_trap:-}" ]]; then
    eval "$__orca_user_debug_trap" || true
  fi
}
__orca_osc133_preexec() {
  __orca_run_user_debug_trap
  # Why: a framework (bash-preexec/starship) may replace our DEBUG trap at the
  # first prompt; __orca_osc133_epilogue re-takes it each prompt and stores the
  # framework's trap here, so the framework's own preexec still runs while our
  # command-start C survives its re-arm.
  if [[ -n "\${__orca_chained_debug_trap:-}" ]]; then
    eval "$__orca_chained_debug_trap" || true
  fi
  [[ -z "\${__orca_in_prompt_command:-}" ]] || return
  # Why: a chained trap can invoke us more than once for a single command, so
  # emit C only on the first fire (the __orca_in_command gate), and never for a
  # prompt-time hook — ours or bash-preexec's __bp_* helpers.
  [[ -z "\${__orca_in_command:-}" ]] || return
  case "$BASH_COMMAND" in
    *__orca_osc133_*|*__bp_*) return ;;
  esac
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
# Why: runs LAST every prompt — closes the prompt window (so command starts emit
# C) and re-arms our single DEBUG trap. A framework that replaced DEBUG at the
# first prompt is captured and chained rather than discarded, so it keeps working
# while its re-arm can no longer silence Orca's command-start signal.
__orca_osc133_epilogue() {
  unset __orca_in_prompt_command
  local __orca_spec="$(trap -p DEBUG)"
  case "$__orca_spec" in
    "" | *__orca_osc133_preexec* ) __orca_chained_debug_trap="" ;;
    * )
      __orca_spec="\${__orca_spec#trap -- }"
      __orca_spec="\${__orca_spec% DEBUG}"
      eval "__orca_chained_debug_trap=$__orca_spec"
      ;;
  esac
  trap '__orca_osc133_preexec' DEBUG
}
# Why: normalize an array PROMPT_COMMAND (bash 5.1+) to a string so prepend/append
# below is uniform, and capture $? in precmd before the user's chain mutates it.
__orca_normalize_prompt_command() {
  local __orca_joined="" __orca_prompt_part
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    for __orca_prompt_part in "\${PROMPT_COMMAND[@]}"; do
      [[ -n "$__orca_prompt_part" ]] || continue
      if [[ -n "$__orca_joined" ]]; then
        __orca_joined="$__orca_joined;$__orca_prompt_part"
      else
        __orca_joined="$__orca_prompt_part"
      fi
    done
    PROMPT_COMMAND="$__orca_joined"
  fi
}
__orca_normalize_prompt_command
PROMPT_COMMAND="__orca_osc133_precmd\${PROMPT_COMMAND:+;\${PROMPT_COMMAND}};__orca_osc133_epilogue"
__orca_debug_trap_spec="$(trap -p DEBUG)"
if [[ -n "$__orca_debug_trap_spec" ]]; then
  __orca_debug_trap_command="\${__orca_debug_trap_spec#trap -- }"
  __orca_debug_trap_command="\${__orca_debug_trap_command% DEBUG}"
  eval "__orca_user_debug_trap=$__orca_debug_trap_command"
fi
unset __orca_debug_trap_spec __orca_debug_trap_command
unset -f __orca_normalize_prompt_command
# Why: arm DEBUG after wrapper setup; otherwise bash treats our own rcfile
# commands as a foreground command and emits a fake C/D before the first prompt.
trap '__orca_osc133_preexec' DEBUG
`
}

export function getDaemonZshShellReadyRcfileContent(): string {
  return `# Orca daemon zsh shell-ready wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zshrc',
  interactiveOnly: true,
  skipWhenHomeIsCurrentZdotdir: true
})}
__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
[[ ! -o login ]] && __orca_restore_agent_teams_path
if [[ ! -o login ]]; then
  # Why: ~/.zshrc can export the user's default OpenCode config after spawn.
  [[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
  [[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
  ${getPosixOmpShellWrapper()}
  [[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"
  ${getPosixCodexShellLaunchPreflight()}
fi
__orca_osc133_precmd() {
  local exit_code=$?
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
}
__orca_osc133_preexec() {
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
# Why: prepend so Orca captures $? before user prompt hooks can overwrite it.
precmd_functions=(__orca_osc133_precmd \${precmd_functions[@]})
preexec_functions=(__orca_osc133_preexec \${preexec_functions[@]})
if [[ ! -o login ]]; then
${getZshFinalZdotdirRestoreBlock()}
fi
`
}

function ensureShellReadyWrappers(): void {
  if (process.platform === 'win32') {
    return
  }
  if (didEnsureShellReadyWrappers && shellReadyWrappersExist()) {
    return
  }
  didEnsureShellReadyWrappers = true

  const root = getShellReadyWrapperRoot()
  const zshDir = join(root, 'zsh')
  const bashDir = join(root, 'bash')

  const zshEnv = getZshEnvTemplate(zshDir, 'daemon')
  const zshProfile = `# Orca daemon zsh shell-ready wrapper
${getZshStartupFileSourceBlock({ fileName: '.zprofile' })}
`
  const zshRc = getDaemonZshShellReadyRcfileContent()
  const zshLogin = `# Orca daemon zsh shell-ready wrapper
${getZshStartupFileSourceBlock({ fileName: '.zlogin', interactiveOnly: true })}
__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__orca_restore_agent_teams_path
# Why: .zlogin is the final login startup file before the prompt is shown.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
${getPosixOmpShellWrapper()}
[[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight()}
${getZshShellReadyMarkerRegistrationBlock(SHELL_READY_MARKER)}
${getZshFinalZdotdirRestoreBlock()}
`
  const bashRc = getDaemonBashShellReadyRcfileContent()

  const files = [
    [join(zshDir, '.zshenv'), zshEnv],
    [join(zshDir, '.zprofile'), zshProfile],
    [join(zshDir, '.zshrc'), zshRc],
    [join(zshDir, '.zlogin'), zshLogin],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  try {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
      chmodSync(path, 0o644)
    }
  })
}

/** True when every wrapper file is present and non-empty afterwards. */
function ensureShellReadyWrappers(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  const root = getShellReadyWrapperRoot()
  // Why existence alone decides, with no per-process flag: the root is keyed by
  // a hash of the exact bytes we would write, so a tree that is present and
  // non-empty is a tree this build wrote. Rewriting it would replace a live file
  // on the terminal-spawn path for no gain.
  if (!shellReadyWrappersExist()) {
    const written = writeShellWrapperFiles(
      buildDaemonShellReadyWrapperFiles(root),
      '[daemon/shell-ready]'
    )
    if (!written || !shellReadyWrappersExist()) {
      // Why no flag to reset: the next launch re-checks the files themselves, so
      // a half-written tree is retried without any extra bookkeeping.
      return false
    }
  }

  return true
}

export function resolvePtyShellPath(env: Record<string, string>): string {
  if (process.platform === 'win32') {
    return env.ORCA_TERMINAL_WINDOWS_SHELL || 'powershell.exe'
  }
  return env.SHELL || process.env.SHELL || '/bin/zsh'
}

export function shellPathSupportsPtyStartupBarrier(shellPath: string): boolean {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  // Why fish: markerless, its startup command is written before fish's reader owns
  // the PTY and the launch is lost under slow prompts like Starship (STA-3417).
  return shellName === 'zsh' || shellName === 'bash' || shellName === 'fish'
}

export function supportsPtyStartupBarrier(env: Record<string, string>): boolean {
  if (process.platform === 'win32') {
    return false
  }
  return shellPathSupportsPtyStartupBarrier(resolvePtyShellPath(env))
}

export type ShellLaunchConfig = {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
}

const UNWRAPPED: ShellLaunchConfig = {
  args: null,
  env: {},
  supportsReadyMarker: false
}

/**
 * The one launch-config entry point: args + env for a shell that should start
 * with exactly `features` enabled. An empty selection is never wrapped.
 */
export function getShellLaunchConfig(
  shellPath: string,
  features: readonly ShellStartupFeature[]
): ShellLaunchConfig {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()

  if (shellName === 'zsh') {
    if (features.length === 0) {
      return UNWRAPPED
    }
    if (!ensureShellReadyWrappers()) {
      // Why plain login zsh: ZDOTDIR pointed at an incomplete wrapper dir makes
      // zsh skip the user's whole config. Losing Orca's features is recoverable.
      return { args: ['-l'], env: {}, supportsReadyMarker: false }
    }
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: resolveInheritedZdotdir(process.env),
        ORCA_ZSHENV_SOURCE_DIR: resolveInheritedZshenvSourceDir(process.env),
        ZDOTDIR: join(getShellReadyWrapperRoot(), 'zsh'),
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features)
      },
      supportsReadyMarker: features.includes('ready')
    }
  }

  if (shellName === 'bash') {
    if (features.length === 0 || !ensureShellReadyWrappers()) {
      return UNWRAPPED
    }
    return {
      args: ['--rcfile', join(getShellReadyWrapperRoot(), 'bash', 'rcfile')],
      env: {
        [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features)
      },
      supportsReadyMarker: features.includes('ready')
    }
  }

  if (isPowerShellExecutableName(shellName)) {
    return {
      args: [
        '-NoLogo',
        '-NoExit',
        '-EncodedCommand',
        encodePowerShellCommand(getPowerShellOsc133Bootstrap())
      ],
      env: {},
      supportsReadyMarker: false
    }
  }

  // Why: mirrors local-pty-shell-ready.ts; markerless fish stays unwrapped. The
  // selection is baked into the init command, so fish needs no feature env var.
  if (shellName === 'fish' && features.includes('ready')) {
    return {
      args: [
        '-l',
        '-C',
        `${getFishShellReadyInitCommand(SHELL_READY_MARKER)}\n${getFishCodexShellLaunchPreflight()}`
      ],
      env: { ORCA_SHELL_READY_MARKER: '1' },
      supportsReadyMarker: true
    }
  }

  return UNWRAPPED
}
