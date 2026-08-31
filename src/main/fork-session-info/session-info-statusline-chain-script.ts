import { wrapWindowsPowerShellEncodedCommand } from '../agent-hooks/installer-utils'
import { getManagedStatusLineScript as getUpstreamStatusLineScript } from '../claude/statusline-script'

export const SESSION_INFO_STATUSLINE_CHAIN_ENV = 'ORCA_SESSION_INFO_STATUSLINE_CHAIN_ACTIVE'
export const POSIX_STATUSLINE_CHAIN_RUNNER = 'claude-statusline-user.sh'
export const WINDOWS_STATUSLINE_CHAIN_RUNNER = 'claude-statusline-user.cmd'

function getPosixChainBlock(): string {
  return [
    `if [ -z "\${${SESSION_INFO_STATUSLINE_CHAIN_ENV}:-}" ] && [ -n "$HOME" ]; then`,
    `  orca_statusline_chain_runner="$HOME/.orca/agent-hooks/${POSIX_STATUSLINE_CHAIN_RUNNER}"`,
    '  if [ -x "$orca_statusline_chain_runner" ]; then',
    '    orca_statusline_chain_output=$(mktemp "${TMPDIR:-/tmp}/orca-statusline-chain-output.XXXXXX" 2>/dev/null) || orca_statusline_chain_output=',
    '    orca_statusline_chain_input=$(mktemp "${TMPDIR:-/tmp}/orca-statusline-chain-input.XXXXXX" 2>/dev/null) || orca_statusline_chain_input=',
    '    if [ -n "$orca_statusline_chain_output" ] && [ -n "$orca_statusline_chain_input" ]; then',
    '      printf \'%s\' "$payload" >"$orca_statusline_chain_input" 2>/dev/null || :',
    `      ${SESSION_INFO_STATUSLINE_CHAIN_ENV}=1 "$orca_statusline_chain_runner" <"$orca_statusline_chain_input" >"$orca_statusline_chain_output" 2>/dev/null &`,
    '      orca_statusline_chain_pid=$!',
    '      (',
    '        sleep 1',
    '        orca_statusline_chain_descendants=',
    '        orca_statusline_collect_descendants() {',
    '          orca_statusline_children=$(pgrep -P "$1" 2>/dev/null) || orca_statusline_children=',
    '          for orca_statusline_child in $orca_statusline_children; do',
    '            orca_statusline_collect_descendants "$orca_statusline_child"',
    '            orca_statusline_chain_descendants="$orca_statusline_chain_descendants $orca_statusline_child"',
    '          done',
    '        }',
    '        if command -v pgrep >/dev/null 2>&1; then',
    '          orca_statusline_collect_descendants "$orca_statusline_chain_pid"',
    '        fi',
    '        kill -TERM $orca_statusline_chain_descendants "$orca_statusline_chain_pid" 2>/dev/null || :',
    '        sleep 0.1',
    '        kill -KILL $orca_statusline_chain_descendants "$orca_statusline_chain_pid" 2>/dev/null || :',
    '      ) &',
    '      orca_statusline_chain_watchdog=$!',
    '      wait "$orca_statusline_chain_pid" 2>/dev/null',
    '      orca_statusline_chain_status=$?',
    '      kill "$orca_statusline_chain_watchdog" 2>/dev/null || :',
    '      wait "$orca_statusline_chain_watchdog" 2>/dev/null || :',
    '      if [ "$orca_statusline_chain_status" -eq 0 ]; then',
    '        cat "$orca_statusline_chain_output" 2>/dev/null || :',
    '      fi',
    '    fi',
    '    rm -f "$orca_statusline_chain_output" "$orca_statusline_chain_input" 2>/dev/null || :',
    '  fi',
    'fi'
  ].join('\n')
}

function getWindowsRelayCommand(): string {
  const runnerRelativePath = `.orca\\agent-hooks\\${WINDOWS_STATUSLINE_CHAIN_RUNNER}`
  return wrapWindowsPowerShellEncodedCommand(
    [
      `$runner = Join-Path $env:USERPROFILE '${runnerRelativePath}';`,
      '$payload = $env:ORCA_STATUSLINE_PAYLOAD_FILE;',
      'if (-not (Test-Path -LiteralPath $runner -PathType Leaf) -or -not (Test-Path -LiteralPath $payload -PathType Leaf)) { exit 0 };',
      '$output = [IO.Path]::GetTempFileName();',
      '$process = $null; $outputStream = $null;',
      'try {',
      '  $psi = [Diagnostics.ProcessStartInfo]::new();',
      '  $psi.FileName = $env:ComSpec;',
      '  $psi.Arguments = \'/d /s /c ""%ORCA_CHAIN_RUNNER_PATH%" < "%ORCA_CHAIN_PAYLOAD_PATH%""\';',
      '  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true;',
      '  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true;',
      `  $psi.EnvironmentVariables['${SESSION_INFO_STATUSLINE_CHAIN_ENV}'] = '1';`,
      "  $psi.EnvironmentVariables['ORCA_CHAIN_RUNNER_PATH'] = $runner;",
      "  $psi.EnvironmentVariables['ORCA_CHAIN_PAYLOAD_PATH'] = $payload;",
      '  $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi;',
      '  if (-not $process.Start()) { exit 0 };',
      '  $outputStream = [IO.File]::Create($output);',
      '  $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($outputStream);',
      '  $stderrTask = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null);',
      '  if (-not $process.WaitForExit(1000)) {',
      '    try { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $process.Id /T /F *> $null } catch {};',
      '    $null = $process.WaitForExit(100);',
      '    exit 0;',
      '  };',
      '  $stdoutReady = $stdoutTask.Wait(100); $stderrReady = $stderrTask.Wait(100);',
      '  $outputStream.Flush(); $outputStream.Dispose(); $outputStream = $null;',
      '  if ($process.ExitCode -eq 0 -and $stdoutReady -and $stderrReady) {',
      '    $source = [IO.File]::OpenRead($output);',
      '    try { $source.CopyTo([Console]::OpenStandardOutput()) } finally { $source.Dispose() };',
      '  };',
      '} catch {',
      '} finally {',
      '  if ($null -ne $outputStream) { $outputStream.Dispose() };',
      '  if ($null -ne $process) { $process.Dispose() };',
      '  Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue;',
      '}'
    ].join(' ')
  )
}

function getWindowsChainBlock(): string {
  const runner = `%USERPROFILE%\\.orca\\agent-hooks\\${WINDOWS_STATUSLINE_CHAIN_RUNNER}`
  return `if not defined ${SESSION_INFO_STATUSLINE_CHAIN_ENV} if exist "${runner}" ${getWindowsRelayCommand()} 2>nul`
}

/** Include context telemetry for API-key sessions as well as subscriber rate limits. */
function widenStatusLineTelemetryGate(script: string, windows: boolean): string {
  if (windows) {
    const argumentEscape = '\\'
    return script.replace(
      `/c:${argumentEscape}"rate_limits${argumentEscape}" "%ORCA_STATUSLINE_PAYLOAD_FILE%"`,
      `/c:${argumentEscape}"rate_limits${argumentEscape}" /c:${argumentEscape}"context_window${argumentEscape}" "%ORCA_STATUSLINE_PAYLOAD_FILE%"`
    )
  }
  return script.replace(
    '  *\'"rate_limits"\'*) ;;',
    '  *\'"rate_limits"\'*|*\'"context_window"\'*) ;;'
  )
}

/** Add fail-open user-command chaining to the upstream managed statusline script. */
export function getManagedStatusLineScript(target: 'local' | 'posix' = 'local'): string {
  const windows = target === 'local' && process.platform === 'win32'
  const upstream = widenStatusLineTelemetryGate(getUpstreamStatusLineScript(target), windows)
  if (windows) {
    const anchor = 'set "ORCA_STATUSLINE_STAMP_FILE='
    const index = upstream.indexOf(anchor)
    if (index === -1) {
      return upstream
    }
    return `${upstream.slice(0, index)}${getWindowsChainBlock()}\r\n${upstream.slice(index)}`
  }

  const anchor = 'if [ -z "$payload" ]; then\n  exit 0\nfi\n'
  const index = upstream.indexOf(anchor)
  if (index === -1) {
    return upstream
  }
  const insertion = index + anchor.length
  return `${upstream.slice(0, insertion)}${getPosixChainBlock()}\n${upstream.slice(insertion)}`
}
