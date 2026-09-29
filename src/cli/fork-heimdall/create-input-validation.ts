import type { z } from 'zod'
import { RuntimeClientError } from '../runtime-client'

export function parseHeimdallCreateSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  prefix: string
): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  const details = parsed.error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.')
    return `${path || 'input'}: ${issue.message}`
  })
  throw new RuntimeClientError('invalid_argument', details.join('; '))
}
