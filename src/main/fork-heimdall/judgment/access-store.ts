import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { JudgmentProviderSchema } from '../../../shared/fork-heimdall/judgment/types'

const JudgmentAccessSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      provider: JudgmentProviderSchema.default('typesafe'),
      apiKey: z.string().trim().min(1).max(4096)
    })
    .strict()
])

export type JudgmentAccess = z.infer<typeof JudgmentAccessSchema>

export function judgmentAccessPath(databasePath: string): string {
  return join(dirname(databasePath), 'judgment-access.json')
}

/** Credentials stay beside the local registry, never in enrollment or fleet state. */
export function readJudgmentAccess(databasePath: string): JudgmentAccess {
  const path = judgmentAccessPath(databasePath)
  try {
    const metadata = statSync(path)
    if (!metadata.isFile() || metadata.size > 8192) {
      throw new Error('Invalid judgment access store')
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('Judgment access store must be private (chmod 600)')
    }
    const parsed = JudgmentAccessSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) {
      throw new Error('Invalid judgment access store')
    }
    return parsed.data
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { enabled: false }
    }
    // Parse and filesystem errors can contain credentials or local paths.
    throw new Error('Judgment access unavailable: use valid private judgment-access.json')
  }
}
