import fs from 'node:fs';
import path from 'node:path';

/**
 * GeoIP 解析：走 ip-api.com 免费批量接口。
 * - 内存缓存 + 落盘缓存（data/geo-cache.json），同一个 IP 只查一次
 * - 攒够 batchSize 或到 flushMs 就批量发一次（批量只算 1 次配额）
 * - 查询结果通过回调通知调用方，用于回填事件坐标
 */
export class GeoResolver {
  constructor(opts, log = console.log) {
    this.o = opts;
    this.log = log;
    this.cacheFile = path.join(opts.cacheDir, 'geo-cache.json');
    this.cache = new Map();
    this.known = new Set();
    this.queue = [];
    this.waiters = new Map();
    this.timer = null;
    this.running = false;
    this.lastReqAt = 0;
    this.stats = { requests: 0, resolved: 0, failed: 0, batches: 0 };
    this.loadCache();
    this.cacheTimer = setInterval(() => this.persistCache(), opts.cacheFlushMs);
    this.cacheTimer.unref?.();
  }

  loadCache() {
    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const obj = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [ip, geo] of Object.entries(obj)) {
        this.cache.set(ip, geo);
        this.known.add(ip);
      }
      this.log(`[geo] 载入缓存 ${this.cache.size} 条`);
    } catch (e) {
      this.log(`[geo] 缓存读取失败: ${e.message}`);
    }
  }

  persistCache() {
    try {
      const obj = {};
      for (const [ip, geo] of this.cache) obj[ip] = geo;
      fs.writeFileSync(this.cacheFile, JSON.stringify(obj));
    } catch (e) {
      this.log(`[geo] 缓存写入失败: ${e.message}`);
    }
  }

  isKnown(ip) {
    return this.known.has(ip);
  }

  get(ip) {
    return this.cache.get(ip) ?? null;
  }

  /** 解析一个 IP；命中缓存立即回调，否则排队等批量查询 */
  enqueue(ip, cb) {
    if (this.known.has(ip)) {
      cb(this.cache.get(ip) ?? null);
      return;
    }
    if (!this.waiters.has(ip)) {
      this.waiters.set(ip, []);
      this.queue.push(ip);
      this.schedule();
    }
    this.waiters.get(ip).push(cb);
  }

  schedule() {
    if (this.timer || this.running) return;
    const wait = Math.max(0, this.o.minIntervalMs - (Date.now() - this.lastReqAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, Math.min(this.o.flushMs, wait));
    this.timer.unref?.();
  }

  async flush() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const batch = this.queue.splice(0, this.o.batchSize);
    this.lastReqAt = Date.now();
    this.stats.requests++;
    this.stats.batches++;

    try {
      const res = await fetch(this.o.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((ip) => ({ query: ip }))),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      for (const item of list) {
        const ip = item.query;
        const geo =
          item.status === 'success'
            ? {
                cc: item.countryCode || '??',
                country: item.country || '未知',
                city: item.city || '',
                lat: item.lat,
                lon: item.lon,
                isp: item.isp || '',
                as: item.as || '',
              }
            : null;
        this.cache.set(ip, geo);
        this.known.add(ip);
        if (geo) this.stats.resolved++;
        else this.stats.failed++;
        this.notify(ip, geo);
      }
    } catch (e) {
      this.log(`[geo] 批量查询失败 (${batch.length} 个): ${e.message}`);
      for (const ip of batch) {
        // 不写入 known，下次还能重试
        this.notify(ip, null, true);
      }
    } finally {
      this.running = false;
      if (this.queue.length) this.schedule();
    }
  }

  notify(ip, geo, failed = false) {
    const ws = this.waiters.get(ip);
    if (!ws) return;
    this.waiters.delete(ip);
    for (const cb of ws) {
      try {
        cb(geo, failed);
      } catch {
        /* 调用方异常不影响队列 */
      }
    }
  }
}
