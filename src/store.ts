import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Tiny JSON-file-backed state store.
 *
 * Chosen over SQLite to avoid a native build dependency (better-sqlite3 needs a
 * compiler toolchain in the image). The dataset here is tiny — a set of synced
 * activity ids plus a small audit log — so a single atomically-written JSON file
 * is more than sufficient.
 */

export interface SyncRecord {
  activityId: string;
  name: string;
  syncedAt: string; // ISO
  garminStatus: 'uploaded' | 'duplicate';
  garminUploadId?: string | number;
  setCount: number;
}

interface StoreData {
  syncedActivities: Record<string, SyncRecord>;
}

export class Store {
  private readonly file: string;
  private data: StoreData = { syncedActivities: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sync-state.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const onDisk = await this.readDisk();
    if (onDisk) {
      this.data = { syncedActivities: onDisk };
    } else {
      await this.flush();
    }
  }

  /**
   * Pick up records another process wrote since we last looked.
   *
   * The server holds this store for its whole lifetime, but `npm run backfill`
   * (or any one-off script) runs as a separate process against the same file.
   * Without this, the server would never see those records — and worse, its
   * next write would replace the file with its stale copy and erase them.
   * Call before a sync pass so dedup reflects the file, not just memory.
   */
  async refresh(): Promise<void> {
    const onDisk = await this.readDisk();
    if (onDisk) {
      // Union; on a clash keep ours — it can only be the same activity anyway.
      this.data.syncedActivities = { ...onDisk, ...this.data.syncedActivities };
    }
  }

  /** The file's records, or undefined if it doesn't exist yet. */
  private async readDisk(): Promise<Record<string, SyncRecord> | undefined> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      return parsed.syncedActivities ?? {};
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  isSynced(activityId: string): boolean {
    return Boolean(this.data.syncedActivities[activityId]);
  }

  getRecord(activityId: string): SyncRecord | undefined {
    return this.data.syncedActivities[activityId];
  }

  async recordSync(record: SyncRecord): Promise<void> {
    this.data.syncedActivities[record.activityId] = record;
    await this.flush();
  }

  /**
   * Serialize writes and write atomically (temp file + rename).
   *
   * The chain is advanced with a settled promise so one failed write can't
   * poison it — if it did, every later recordSync() would silently no-op and
   * dedup would stop working. The caller still sees the real error.
   */
  private flush(): Promise<void> {
    const write = this.writeChain.then(
      () => this.writeOnce(),
      () => this.writeOnce(),
    );
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private async writeOnce(): Promise<void> {
    // Merge first so a write never drops another process's records. The pid in
    // the temp name keeps two processes from clobbering each other's temp file.
    await this.refresh();
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}
