import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { createLocalReviewFilesystem } from './review-local-filesystem'
import { ReviewRunService } from './review-run-service'
import type { ReviewRunCreateInput, ReviewWorkspace } from './review-run-contract'

export type ReviewRuntimeTarget = {
  worktree: { id: string; path: string }
  connectionId?: string
  wslDistro?: string
}

export type ReviewRuntimeCommandsDependencies = {
  resolveRuntimeFileTarget(worktree: string): Promise<ReviewRuntimeTarget>
}

export class ReviewRuntimeCommands {
  constructor(private readonly dependencies: ReviewRuntimeCommandsDependencies) {}

  async runCreate(worktree: string, input: ReviewRunCreateInput) {
    return (await this.service(worktree)).create(input)
  }

  async runList(worktree: string) {
    return (await this.service(worktree)).list()
  }

  async runShow(worktree: string, run: string) {
    return (await this.service(worktree)).show(run)
  }

  async runAbort(worktree: string, run: string) {
    return (await this.service(worktree)).abort(run)
  }

  async runFail(worktree: string, run: string, reason?: string) {
    return (await this.service(worktree)).fail(run, reason)
  }

  async dismiss(worktree: string, run: string, finding: string, reason: string) {
    return (await this.service(worktree)).dismiss(run, finding, reason)
  }

  async staleness(worktree: string, run: string) {
    return (await this.service(worktree)).staleness(run)
  }

  private async service(selector: string): Promise<ReviewRunService> {
    const target = await this.dependencies.resolveRuntimeFileTarget(selector)
    if (target.wslDistro) {
      throw new Error(
        `Adversarial review run storage is not available for WSL workspaces (${target.wslDistro})`
      )
    }
    const filesystem = target.connectionId
      ? getSshFilesystemProvider(target.connectionId)
      : createLocalReviewFilesystem()
    if (!filesystem) {
      throw new Error('review_execution_host_unavailable')
    }
    const workspace: ReviewWorkspace = {
      id: target.worktree.id,
      rootPath: target.worktree.path,
      filesystem
    }
    return new ReviewRunService(workspace)
  }
}
