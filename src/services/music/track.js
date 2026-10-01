class Track {
  constructor({ id, title, url, duration = null, source = 'youtube', requestedBy = null, thumbnail = null }) {
    if (!id || typeof id !== 'string') throw new TypeError('Track: "id" é obrigatório.');
    if (!title || typeof title !== 'string') throw new TypeError('Track: "title" é obrigatório.');
    if (!url || typeof url !== 'string') throw new TypeError('Track: "url" é obrigatória.');

    this.id = id;
    this.title = title;
    this.url = url;
    this.duration = Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null;
    this.source = source;
    this.requestedBy = requestedBy;
    this.thumbnail = typeof thumbnail === 'string' && thumbnail ? thumbnail : null;
    this.addedAt = Date.now();
  }

  get seconds() {
    return this.duration;
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      url: this.url,
      duration: this.duration,
      source: this.source,
      requestedBy: this.requestedBy,
      thumbnail: this.thumbnail,
      addedAt: this.addedAt,
    };
  }
}

module.exports = Track;
