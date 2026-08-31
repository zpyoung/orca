/** Serializes artifact password lifecycle work by profile, cloud scope, and source. */
export class ArtifactPasswordOperationQueue {
  private readonly queues = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = previous.catch(() => {})
    const current = ready.then(() => released)
    this.queues.set(key, current)
    await ready
    try {
      return await operation()
    } finally {
      release()
      if (this.queues.get(key) === current) {
        this.queues.delete(key)
      }
    }
  }
}
