/**
 * Regression test for scripts/pilot-reset.mjs --execute-storage.
 *
 * Guards the pagination bug where a delete-while-listing loop only cleared the
 * first 100-object page. Proves, with 126+ objects across folders:
 *   1. all pages are deleted (full pagination);
 *   2. the bucket remains;
 *   3. rerunning is idempotent;
 *   4. partial failures throw (CLI turns this into a non-zero exit);
 *   5. the final verification count is zero.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs operator script, no types
import { listAllFiles, purgeBucket, purgeAllStorage } from '../../../scripts/pilot-reset.mjs';

/** In-memory Storage double that mimics Supabase's list() paging + folders. */
function makeStorage(initialPaths: string[], opts: { failOnBatch?: number } = {}) {
  const files = new Set(initialPaths);
  const bucketExists = { avatars: true };
  let removeCalls = 0;
  const listCalls: Array<{ prefix: string; offset: number }> = [];

  const bucketApi = {
    async list(prefix: string, { limit, offset }: { limit: number; offset: number }) {
      listCalls.push({ prefix, offset });
      const p = prefix ? prefix + '/' : '';
      const children = new Map<string, boolean>(); // name -> isFolder
      for (const f of files) {
        if (!f.startsWith(p)) continue;
        const rest = f.slice(p.length);
        if (rest.length === 0) continue;
        const seg = rest.split('/')[0];
        const isFolder = rest.includes('/');
        if (!children.has(seg)) children.set(seg, isFolder);
      }
      const entries = [...children.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, isFolder]) => (isFolder ? { name, id: null } : { name, id: `id-${p}${name}` }));
      return { data: entries.slice(offset, offset + limit), error: null };
    },
    async remove(paths: string[]) {
      removeCalls += 1;
      if (opts.failOnBatch && removeCalls === opts.failOnBatch) {
        return { data: null, error: { message: 'simulated storage failure' } };
      }
      for (const path of paths) {
        if (!files.has(path)) return { data: null, error: { message: `not found: ${path}` } };
        files.delete(path);
      }
      return { data: paths.map((name) => ({ name })), error: null };
    },
  };

  const storage = {
    async listBuckets() {
      return { data: Object.keys(bucketExists).map((id) => ({ id, name: id, public: true })), error: null };
    },
    from: (_id: string) => bucketApi,
  };

  return { storage, bucketApi, files, listCalls, get removeCalls() { return removeCalls; }, bucketExists };
}

// 126 objects: 120 at the root + 6 nested under a folder (forces >1 page AND recursion).
function make126(): string[] {
  const root = Array.from({ length: 120 }, (_, i) => `file-${String(i).padStart(3, '0')}.jpg`);
  const nested = Array.from({ length: 6 }, (_, i) => `2024/sub/nested-${i}.jpg`);
  return [...root, ...nested];
}

describe('pilot-reset storage purge — full pagination', () => {
  it('1+5. deletes every object across all pages, final count zero', async () => {
    const s = makeStorage(make126());
    const removed = await purgeBucket(s.bucketApi, { batchSize: 100 });
    expect(removed).toBe(126);
    expect(s.files.size).toBe(0);
    const leftover = await listAllFiles(s.bucketApi, '', 100);
    expect(leftover).toHaveLength(0);
    // Proves it paginated rather than stopping after one page.
    expect(s.listCalls.some((c) => c.offset >= 100)).toBe(true);
  });

  it('2. the bucket itself is preserved', async () => {
    const s = makeStorage(make126());
    await purgeAllStorage(s.storage, { batchSize: 100 });
    const after = await s.storage.listBuckets();
    expect(after.data?.map((b) => b.id)).toContain('avatars');
    expect(s.bucketExists.avatars).toBe(true);
  });

  it('3. rerunning is idempotent (0 removed, no throw)', async () => {
    const s = makeStorage(make126());
    await purgeBucket(s.bucketApi, { batchSize: 100 });
    const second = await purgeBucket(s.bucketApi, { batchSize: 100 });
    expect(second).toBe(0);
  });

  it('4. a partial failure throws (drives a non-zero exit)', async () => {
    const s = makeStorage(make126(), { failOnBatch: 2 }); // second remove batch fails
    await expect(purgeBucket(s.bucketApi, { batchSize: 100 })).rejects.toThrow(/remove batch failed after 100/);
    // The first batch did delete; the failure stops the run (does not silently continue).
    expect(s.files.size).toBeGreaterThan(0);
  });

  it('purgeAllStorage reports total across buckets', async () => {
    const s = makeStorage(make126());
    const res = await purgeAllStorage(s.storage, { batchSize: 100 });
    expect(res.total).toBe(126);
    expect(res.buckets).toContain('avatars');
  });
});
