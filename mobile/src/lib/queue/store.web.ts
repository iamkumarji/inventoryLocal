import type { Job, QueueStore } from "./core";

const KEY = "erp-queue-v1";

/** Browser build (used for testing the app in a browser): the queue lives in localStorage. */
class LocalStorageStore implements QueueStore {
  private read(): Record<string, Job> {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}") as Record<string, Job>;
    } catch {
      return {};
    }
  }

  private write(jobs: Record<string, Job>) {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(jobs));
  }

  async all(): Promise<Job[]> {
    return Object.values(this.read()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async put(job: Job): Promise<void> {
    const jobs = this.read();
    jobs[job.id] = job;
    this.write(jobs);
  }

  async remove(id: string): Promise<void> {
    const jobs = this.read();
    delete jobs[id];
    this.write(jobs);
  }
}

export function createStore(): QueueStore {
  return new LocalStorageStore();
}
