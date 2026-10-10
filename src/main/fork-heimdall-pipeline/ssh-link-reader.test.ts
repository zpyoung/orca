import type { SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SftpFactory } from '../providers/ssh-filesystem-download'
import type { IFilesystemProvider } from '../providers/types'
import { createWslHookSftpAdapter } from '../agent-hooks/wsl-hook-fs-adapter'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { attachPipelineLinkReader } from './ssh-link-reader'

type MuxRequest = SshChannelMultiplexer['request']
type SftpReadlink = NonNullable<SFTPWrapper['readlink']>

const multiplexers: SshChannelMultiplexer[] = []

afterEach(() => {
  for (const mux of multiplexers.splice(0)) {
    mux.dispose()
  }
})

function createMultiplexer(): SshChannelMultiplexer {
  const mux = new SshChannelMultiplexer({
    write: () => true,
    onData: () => {},
    onClose: () => {}
  })
  multiplexers.push(mux)
  return mux
}

function filesystemProvider(): IFilesystemProvider {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected filesystem operation')
  }
  return {
    readDir: unavailable,
    readFile: unavailable,
    writeFile: unavailable,
    writeFileBase64: unavailable,
    writeFileBase64Chunk: unavailable,
    stat: unavailable,
    deletePath: unavailable,
    createFile: unavailable,
    createDir: unavailable,
    createDirNoClobber: unavailable,
    rename: unavailable,
    renameNoClobber: unavailable,
    copy: unavailable,
    realpath: unavailable,
    search: unavailable,
    listFiles: unavailable,
    watch: unavailable
  }
}

function createSftpFixture(readlinkImplementation: SftpReadlink) {
  const sftp = createWslHookSftpAdapter(createMultiplexer())
  sftp.readlink = vi.fn<SftpReadlink>(readlinkImplementation)
  sftp.end = vi.fn()
  return { sftp, createSftp: vi.fn<SftpFactory>(async () => sftp) }
}

function createReader(request: MuxRequest, createSftp?: SftpFactory) {
  const mux = createMultiplexer()
  vi.spyOn(mux, 'request').mockImplementation(request)
  const provider = filesystemProvider()
  attachPipelineLinkReader(provider, mux, createSftp)
  const readlink = provider.readlink
  if (readlink === undefined) {
    throw new Error('Pipeline link reader was not attached')
  }
  return readlink
}

function methodNotFound(): Error {
  return Object.assign(new Error('Method not found'), { code: -32601 })
}

describe('pipeline SSH link reader', () => {
  it('uses SFTP readlink for an old relay and closes the channel', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    const { sftp, createSftp } = createSftpFixture((_filePath, callback) =>
      callback(undefined, '../dangling-target')
    )
    const readlink = createReader(request, createSftp)

    await expect(readlink('/repo/link')).resolves.toBe('../dangling-target')
    expect(request).toHaveBeenCalledWith('fs.readlink', { filePath: '/repo/link' })
    expect(createSftp).toHaveBeenCalledOnce()
    expect(sftp.readlink).toHaveBeenCalledWith('/repo/link', expect.any(Function))
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('closes the old-relay SFTP channel when readlink fails', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    const failure = new Error('remote link is inaccessible')
    const { sftp, createSftp } = createSftpFixture((_filePath, callback) => callback(failure, ''))
    const readlink = createReader(request, createSftp)

    await expect(readlink('/repo/link')).rejects.toBe(failure)
    expect(sftp.end).toHaveBeenCalledOnce()
  })

  it('does not use SFTP for transport failures, even when the message says method not found', async () => {
    const transportFailure = Object.assign(
      new Error('Method not found while the SSH connection was lost'),
      { code: 'CONNECTION_LOST' }
    )
    const request = vi.fn().mockRejectedValue(transportFailure)
    const createSftp = vi.fn()
    const readlink = createReader(request, createSftp)

    await expect(readlink('/repo/link')).rejects.toBe(transportFailure)
    expect(createSftp).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 42, {}])(
    'rejects malformed relay results (%s) without SFTP',
    async (result) => {
      const request = vi.fn().mockResolvedValue(result)
      const createSftp = vi.fn()
      const readlink = createReader(request, createSftp)

      await expect(readlink('/repo/link')).rejects.toThrow('Invalid fs.readlink result')
      expect(createSftp).not.toHaveBeenCalled()
    }
  )

  it('reports that the old system-SSH host cannot read links without SFTP', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    const readlink = createReader(request)

    await expect(readlink('/repo/link')).rejects.toThrow('remote_readlink_unavailable')
  })
})
