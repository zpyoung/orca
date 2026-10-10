import type { SFTPWrapper } from 'ssh2'
import type { SftpFactory } from '../providers/ssh-filesystem-download'
import type { IFilesystemProvider } from '../providers/types'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'

function readSftpLinkTarget(sftp: SFTPWrapper, filePath: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  try {
    sftp.readlink(filePath, (error, target) => {
      if (error) {
        reject(error)
      } else if (typeof target !== 'string') {
        reject(new Error('Invalid SFTP readlink result'))
      } else {
        resolve(target)
      }
    })
  } catch (error) {
    reject(error)
  }
  return promise
}

export function attachPipelineLinkReader(
  provider: IFilesystemProvider,
  mux: SshChannelMultiplexer,
  createSftp?: SftpFactory
): void {
  provider.readlink = async (filePath) => {
    try {
      const target = await mux.request('fs.readlink', { filePath })
      if (typeof target !== 'string') {
        throw new Error('Invalid fs.readlink result')
      }
      return target
    } catch (error) {
      if (!isMethodNotFoundError(error)) {
        throw error
      }
      if (!createSftp) {
        throw new Error('remote_readlink_unavailable')
      }
      const sftp = await createSftp()
      try {
        return await readSftpLinkTarget(sftp, filePath)
      } finally {
        sftp.end()
      }
    }
  }
}
