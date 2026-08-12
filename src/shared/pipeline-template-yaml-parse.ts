import { parseDocument } from 'yaml'
import { MAX_ORCA_YAML_ALIAS_COUNT, isOrcaYamlTextWithinLimit } from './orca-yaml-file-limit'
import { isPlainMap } from './pipeline-template-raw-map'
import type { PipelineTemplateError } from './pipeline-template-types'

export type YamlParseResult =
  | { ok: true; root: Record<string, unknown> }
  | { ok: false; error: PipelineTemplateError }

function ruleOneError(message: string): { ok: false; error: PipelineTemplateError } {
  return { ok: false, error: { rule: 1, message } }
}

/** T11 rule 1: parses template YAML into a plain object, or reports why it could not. */
export function parsePipelineTemplateYaml(content: string): YamlParseResult {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return ruleOneError('Template content exceeds the maximum allowed size.')
  }

  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0) {
      return ruleOneError('Template YAML failed to parse.')
    }
    root = document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch {
    return ruleOneError('Template YAML failed to parse.')
  }

  if (!isPlainMap(root)) {
    return ruleOneError('Template document root must be a YAML map.')
  }

  return { ok: true, root }
}
