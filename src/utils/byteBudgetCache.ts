/**
 * A least-recently-used cache limited by memory, not by number of entries.
 *
 * The general cache (cache.ts) caps entry count, which is the wrong limit for
 * entries whose size varies a lot: one climate record is about 2 MB while most
 * cached responses are a few KB, so 1,000 entries could be 2 GB. Here the caller
 * says how big each entry is, and the oldest-used entries are dropped until the
 * total fits the budget.
 */

interface Entry<V> {
  value: V;
  bytes: number;
}

export class ByteBudgetCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private usedBytes = 0;

  /** @param maxBytes - Total size, in bytes, the cache may hold */
  constructor(readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError(`maxBytes must be a positive number (got ${maxBytes})`);
    }
  }

  /** The value for a key, marking it as most recently used */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    // Map iterates in insertion order, so re-inserting moves the key to the "newest" end
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value, evicting the least recently used entries until it fits.
   *
   * @param bytes - Estimated size of the value
   * @returns false if the value was not stored (empty, or larger than the whole budget)
   */
  set(key: string, value: V, bytes: number): boolean {
    this.delete(key);
    if (!(bytes > 0) || bytes > this.maxBytes) {
      return false;
    }
    while (this.usedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, bytes });
    this.usedBytes += bytes;
    return true;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.entries.delete(key);
    this.usedBytes -= entry.bytes;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }

  /** Number of entries held */
  get size(): number {
    return this.entries.size;
  }

  /** Total estimated bytes held */
  get bytes(): number {
    return this.usedBytes;
  }
}
