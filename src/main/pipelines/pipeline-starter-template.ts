/**
 * The shipped `bugfix-fast` starter (→ logic T2). Defined in `src/shared/pipeline-template-
 * starter.ts` so pure shared-layer tests can assert its round-trip through
 * `parsePipelineTemplate`; re-exported here as the file host-side code (e.g. the templates-
 * directory writer) imports from.
 */
export { BUGFIX_FAST_STARTER_TEMPLATE } from '../../shared/pipeline-template-starter'
