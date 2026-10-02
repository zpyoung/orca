import { z } from 'zod'
import { measureUtf8ByteLength } from '../utf8-byte-limits'

export const PipelineSourceTextSchema = z
  .string()
  .refine(
    (text) => measureUtf8ByteLength(text, { stopAfterBytes: 256 * 1024 }).byteLength <= 256 * 1024
  )

export const PipelineSourceSnapshotSchema = z
  .object({ sourceText: PipelineSourceTextSchema })
  .strict()
export type PipelineSourceSnapshot = z.infer<typeof PipelineSourceSnapshotSchema>
