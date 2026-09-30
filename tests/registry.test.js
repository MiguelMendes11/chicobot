import { describe, it, expect } from 'vitest';
import MusicRegistry from '../src/services/music/registry.js';

class FakeSession {
  constructor(id) {
    this.guildId = id;
    this.destroyed = false;
  }
}

describe('MusicRegistry', () => {
  it('retorna a mesma sessão existente quando não está destruída', () => {
    const registry = new MusicRegistry();
    const first = registry.getOrCreate('g1', (id) => new FakeSession(id));
    const second = registry.getOrCreate('g1', (id) => new FakeSession(id));

    expect(second).toBe(first);
    expect(registry.size).toBe(1);
  });

  it('substitui sessão destruída por uma nova (nunca devolve sessão destroyed)', () => {
    const registry = new MusicRegistry();
    const first = registry.getOrCreate('g1', (id) => new FakeSession(id));
    first.destroyed = true;

    const second = registry.getOrCreate('g1', (id) => new FakeSession(id));

    expect(second).not.toBe(first);
    expect(second.destroyed).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.get('g1')).toBe(second);
  });

  it('get/has/delete/list/ids funcionam como esperado', () => {
    const registry = new MusicRegistry();
    const session = registry.getOrCreate('g1', (id) => new FakeSession(id));

    expect(registry.has('g1')).toBe(true);
    expect(registry.get('g1')).toBe(session);
    expect(registry.get('missing')).toBeNull();
    expect(registry.ids()).toEqual(['g1']);
    expect(registry.list()).toEqual([session]);

    registry.delete('g1');
    expect(registry.has('g1')).toBe(false);
    expect(registry.size).toBe(0);
  });
});
