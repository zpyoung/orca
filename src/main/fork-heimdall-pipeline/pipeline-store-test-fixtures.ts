import { PipelineDatabase } from './pipeline-database'
import { PipelineStore } from './pipeline-store'

export function createInMemoryPipelineStore(): PipelineStore {
  return new PipelineStore(new PipelineDatabase(':memory:'))
}
