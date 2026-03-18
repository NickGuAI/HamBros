type AsyncTask<T> = () => Promise<T> | T

export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  enqueue<T>(key: string, task: AsyncTask<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => task())
    const next = run.finally(() => {
      if (this.tails.get(key) === next) {
        this.tails.delete(key)
      }
    })
    this.tails.set(key, next)
    return run
  }

  clear(key: string): void {
    this.tails.delete(key)
  }
}

export function enqueueKeyedTask<T>(
  queue: KeyedAsyncQueue,
  key: string,
  task: AsyncTask<T>,
): Promise<T> {
  return queue.enqueue(key, task)
}
