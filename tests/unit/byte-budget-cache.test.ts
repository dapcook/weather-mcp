import { describe, it, expect } from 'vitest';
import { ByteBudgetCache } from '../../src/utils/byteBudgetCache.js';

describe('ByteBudgetCache', () => {
  it('stores and returns values, tracking their size', () => {
    const cache = new ByteBudgetCache<string>(100);
    expect(cache.set('a', 'alpha', 30)).toBe(true);
    expect(cache.set('b', 'beta', 20)).toBe(true);
    expect(cache.get('a')).toBe('alpha');
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(50);
  });

  it('drops the least recently used entries to stay within the budget', () => {
    const cache = new ByteBudgetCache<string>(100);
    cache.set('a', 'A', 40);
    cache.set('b', 'B', 40);
    cache.set('c', 'C', 40); // 120 > 100: evicts the oldest ('a')
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('B');
    expect(cache.get('c')).toBe('C');
    expect(cache.bytes).toBe(80);
  });

  it('counts a read as use, so recently read entries outlive unread ones', () => {
    const cache = new ByteBudgetCache<string>(100);
    cache.set('a', 'A', 40);
    cache.set('b', 'B', 40);
    cache.get('a'); // 'a' is now newer than 'b'
    cache.set('c', 'C', 40); // evicts 'b', not 'a'
    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeUndefined();
  });

  it('evicts several entries when one large value needs the room', () => {
    const cache = new ByteBudgetCache<string>(100);
    cache.set('a', 'A', 30);
    cache.set('b', 'B', 30);
    cache.set('c', 'C', 30);
    cache.set('big', 'BIG', 80);
    expect(cache.size).toBe(1);
    expect(cache.get('big')).toBe('BIG');
    expect(cache.bytes).toBe(80);
  });

  it('replaces an existing key without double counting', () => {
    const cache = new ByteBudgetCache<string>(100);
    cache.set('a', 'old', 60);
    cache.set('a', 'new', 30);
    expect(cache.get('a')).toBe('new');
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(30);
  });

  it('refuses a value larger than the whole budget, and forgets the stale value for that key', () => {
    const cache = new ByteBudgetCache<string>(100);
    cache.set('a', 'small', 10);
    expect(cache.set('a', 'huge', 101)).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('refuses empty or invalid sizes', () => {
    const cache = new ByteBudgetCache<string>(100);
    expect(cache.set('a', 'x', 0)).toBe(false);
    expect(cache.set('b', 'x', -5)).toBe(false);
    expect(cache.set('c', 'x', NaN)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('can delete and clear', () => {
    const cache = new ByteBudgetCache<string>(100);
    cache.set('a', 'A', 10);
    cache.set('b', 'B', 10);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.bytes).toBe(10);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid budget (%s)', (budget) => {
    expect(() => new ByteBudgetCache<string>(budget)).toThrow(RangeError);
  });
});
