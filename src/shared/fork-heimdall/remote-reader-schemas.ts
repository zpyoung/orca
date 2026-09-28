import type { z } from 'zod'
import { EnrollSuccessSchema, HeimdallSubscriptionEventSchema } from './api'
import { WatcherCommandResultSchema, WatcherDetailSchema } from './fleet-types'

type TraversableDefinition = z.ZodType['def'] & {
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- zod's object def names its field map `shape`.
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  element?: z.ZodType
  options?: readonly z.ZodType[]
  items?: readonly z.ZodType[]
  rest?: z.ZodType | null
  keyType?: z.ZodType
  valueType?: z.ZodType
  left?: z.ZodType
  right?: z.ZodType
  innerType?: z.ZodType
  in?: z.ZodType
  out?: z.ZodType
  input?: z.ZodType
  output?: z.ZodType
  getter?: () => z.ZodType
}

function cloneWith(schema: z.ZodType, updates: Partial<TraversableDefinition>): z.ZodType {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zod's clone() requires the exact discriminated def type; the merge only overwrites known traversal fields already present on that def's variant.
  return schema.clone({ ...schema.def, ...updates } as typeof schema.def)
}

/** Recursively strips strict object keys while preserving passthrough and opaque payloads. */
export function remoteReaderSchema<T extends z.ZodType>(schema: T): T {
  const rewritten = new Map<z.ZodType, z.ZodType>()

  const visit = (current: z.ZodType): z.ZodType => {
    const cached = rewritten.get(current)
    if (cached) {
      return cached
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: current.def is zod's closed base def type for a generic ZodType; the switch below only reads the field that matches definition.type.
    const definition = current.def as TraversableDefinition
    let result: z.ZodType
    switch (definition.type) {
      case 'object': {
        const fields = Object.fromEntries(
          Object.entries(definition.shape ?? {}).map(([key, child]) => [key, visit(child)])
        )
        const catchall = definition.catchall ? visit(definition.catchall) : undefined
        result = cloneWith(current, {
          // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- zod's object def names its field map `shape`.
          shape: fields,
          catchall: definition.catchall?.type === 'never' ? undefined : catchall
        })
        break
      }
      case 'array':
        result = cloneWith(current, { element: visit(definition.element!) })
        break
      case 'tuple':
        result = cloneWith(current, {
          items: definition.items!.map(visit),
          rest: definition.rest ? visit(definition.rest) : definition.rest
        })
        break
      case 'record':
      case 'map':
        result = cloneWith(current, {
          keyType: visit(definition.keyType!),
          valueType: visit(definition.valueType!)
        })
        break
      case 'set':
        result = cloneWith(current, { valueType: visit(definition.valueType!) })
        break
      case 'union':
        result = cloneWith(current, { options: definition.options!.map(visit) })
        break
      case 'intersection':
        result = cloneWith(current, {
          left: visit(definition.left!),
          right: visit(definition.right!)
        })
        break
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
      case 'nonoptional':
      case 'promise':
      case 'success':
        result = cloneWith(current, { innerType: visit(definition.innerType!) })
        break
      case 'pipe':
        result = cloneWith(current, {
          in: visit(definition.in!),
          out: visit(definition.out!)
        })
        break
      case 'function':
        result = cloneWith(current, {
          input: visit(definition.input!),
          output: visit(definition.output!)
        })
        break
      case 'lazy': {
        const getter = definition.getter!
        result = cloneWith(current, { getter: () => visit(getter()) })
        break
      }
      case 'any':
      case 'bigint':
      case 'boolean':
      case 'custom':
      case 'date':
      case 'enum':
      case 'file':
      case 'int':
      case 'literal':
      case 'nan':
      case 'never':
      case 'null':
      case 'number':
      case 'string':
      case 'symbol':
      case 'template_literal':
      case 'transform':
      case 'undefined':
      case 'unknown':
      case 'void':
        result = current
        break
    }

    rewritten.set(current, result)
    return result
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: visit reproduces each node's def.type/shape, so the returned schema is structurally the same variant as the input T.
  return visit(schema) as T
}

export const WatcherDetailReaderSchema = remoteReaderSchema(WatcherDetailSchema)
export const EnrollSuccessReaderSchema = remoteReaderSchema(EnrollSuccessSchema)
export const WatcherCommandResultReaderSchema = remoteReaderSchema(WatcherCommandResultSchema)
export const HeimdallSubscriptionEventReaderSchema = remoteReaderSchema(
  HeimdallSubscriptionEventSchema
)
