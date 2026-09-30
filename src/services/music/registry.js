class MusicRegistry {
  constructor() {
    this.sessions = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  get(guildId) {
    return this.sessions.get(guildId) || null;
  }

  has(guildId) {
    return this.sessions.has(guildId);
  }

  getOrCreate(guildId, factory) {
    const existing = this.get(guildId);

    if (existing) return existing;

    const created = factory(guildId);
    this.sessions.set(guildId, created);

    return created;
  }

  delete(guildId) {
    return this.sessions.delete(guildId);
  }

  ids() {
    return [...this.sessions.keys()];
  }

  list() {
    return [...this.sessions.values()];
  }

  clear() {
    this.sessions.clear();
  }
}

module.exports = MusicRegistry;
