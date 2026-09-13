import fs from 'node:fs';
import path from 'node:path';

/**
 * 事件存储：追加写 JSONL 文件，内存里保留最近 maxEvents 条。
 * 同一个 id 后写的记录会覆盖先写的（用于 GeoIP 解析完成后回填坐标）。
 */
export class Store {
  constructor(dataDir, maxEvents = 8000) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'events.jsonl');
    this.max = maxEvents;
    this.events = [];
    this.byId = new Map();
    this.seq = 0;
    fs.mkdirSync(dataDir, { recursive: true });
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
  }

  load() {
    if (!fs.existsSync(this.file)) return 0;
    const raw = fs.readFileSync(this.file, 'utf8');
    const merged = new Map();
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s);
        if (e && e.id) merged.set(e.id, e);
      } catch {
        /* 忽略半行损坏 */
      }
    }
    this.events = [...merged.values()].sort((a, b) => a.ts - b.ts);
    for (const e of this.events) {
      this.byId.set(e.id, e);
      if (e.id > this.seq) this.seq = e.id;
    }
    this.trim();
    return this.events.length;
  }

  nextId() {
    return ++this.seq;
  }

  add(evt) {
    this.events.push(evt);
    this.byId.set(evt.id, evt);
    this.stream.write(JSON.stringify(evt) + '\n');
    this.trim();
    return evt;
  }

  /** GeoIP 解析完成后回填，返回更新后的事件（若已淘汰则为 null） */
  patchGeo(id, geo) {
    const e = this.byId.get(id);
    if (!e) return null;
    e.geo = geo;
    this.stream.write(JSON.stringify(e) + '\n');
    return e;
  }

  trim() {
    while (this.events.length > this.max) {
      const e = this.events.shift();
      this.byId.delete(e.id);
    }
  }

  recent(n = 60) {
    return this.events.slice(-n).reverse();
  }

  reset() {
    this.events = [];
    this.byId.clear();
    this.seq = 0;
    this.stream.end();
    fs.writeFileSync(this.file, '');
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
  }

  stats() {
    const now = Date.now();
    const dayAgo = now - 86400000;
    const hourBuckets = new Array(24).fill(0);
    const countries = new Map();
    const ports = new Map();
    const sources = new Map();
    let last24h = 0;
    let located = 0;

    for (const e of this.events) {
      const age = now - e.ts;
      if (age <= 86400000) {
        last24h++;
        const h = Math.floor(age / 3600000);
        if (h >= 0 && h < 24) hourBuckets[h]++;
      }
      const cc = e.geo?.cc || '??';
      if (e.geo) located++;
      const c = countries.get(cc) || {
        cc,
        name: e.geo?.country || '未知',
        count: 0,
        lat: e.geo?.lat,
        lon: e.geo?.lon,
      };
      c.count++;
      countries.set(cc, c);

      ports.set(e.port, (ports.get(e.port) || 0) + 1);

      const s = sources.get(e.ip) || { ip: e.ip, count: 0, geo: e.geo };
      s.count++;
      if (!s.geo && e.geo) s.geo = e.geo;
      sources.set(e.ip, s);
    }

    return {
      total: this.events.length,
      last24h,
      located,
      uniqueIps: sources.size,
      uniqueCountries: [...countries.keys()].filter((c) => c !== '??').length,
      startedAt: this.events.length ? this.events[0].ts : now,
      countries: [...countries.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      ports: [...ports.entries()]
        .map(([port, count]) => ({ port, count }))
        .sort((a, b) => b.count - a.count),
      topSources: [...sources.values()].sort((a, b) => b.count - a.count).slice(0, 8),
      timeline: hourBuckets.reverse(),
    };
  }
}
