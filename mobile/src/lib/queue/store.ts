import * as SQLite from "expo-sqlite";

import type { Job, QueueStore } from "./core";

/** Device-local queue in SQLite: survives app restarts and phone reboots. */
export class SqliteStore implements QueueStore {
  private db: Promise<SQLite.SQLiteDatabase>;

  constructor(name = "erp-queue.db") {
    this.db = SQLite.openDatabaseAsync(name).then(async (db) => {
      await db.execAsync(
        "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);",
      );
      return db;
    });
  }

  async all(): Promise<Job[]> {
    const rows = await (await this.db).getAllAsync<{ body: string }>("SELECT body FROM jobs ORDER BY created_at");
    return rows.map((r) => JSON.parse(r.body) as Job);
  }

  async put(job: Job): Promise<void> {
    await (await this.db).runAsync(
      "INSERT INTO jobs (id, created_at, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      job.id,
      job.createdAt,
      JSON.stringify(job),
    );
  }

  async remove(id: string): Promise<void> {
    await (await this.db).runAsync("DELETE FROM jobs WHERE id = ?", id);
  }
}

export function createStore(): QueueStore {
  return new SqliteStore();
}
