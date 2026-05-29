export interface Semaphore {
  acquire(): Promise<() => void>;
}

export function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    available++;
    const next = waiters.shift();
    if (next) {
      available--;
      next();
    }
  };

  return {
    acquire: () =>
      new Promise<() => void>((resolve) => {
        if (available > 0) {
          available--;
          resolve(release);
        } else {
          waiters.push(() => resolve(release));
        }
      }),
  };
}
