import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

export function filesystemErrorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  const code = error.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

// numeric 2 is ssh2's SFTP absence code (SSH_FX_NO_SUCH_FILE), which providers backed by IFilesystemProvider can surface instead of ENOENT.
export function isMissingFilesystemError(error: unknown): boolean {
  return isDefinitiveAbsence(error) || filesystemErrorCode(error) === 2
}
