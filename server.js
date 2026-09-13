import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, trapLabel } from './lib/config.js';
import { Store } from './lib/store.js';
import { GeoResolver } from './lib/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- 存储与 GeoIP ---------------- */

const store = new Store(config.dataDir, config.maxEvents);
log(`[store] 载入历史事件 ${store.load()} 条`);

const geo = new GeoResolver({ ...config.geo, cacheDir: config.dataDir }, log);

/* ---------------- SSE 广播 ---------------- */

const sseClients = new Set();

function broadcast(msg) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

const normIp = (a) => (a || '').replace(/^::ffff:/, '');

/* ---------------- 命中记录 ---------------- */

let hitCount = 0;

function record(evt) {
  const e = {
    id: store.nextId(),
    ts: Date.now(),
    ip: evt.ip,
    port: evt.port,
    kind: evt.kind,
    geo: geo.isKnown(evt.ip) ? geo.get(evt.ip) : null,
  };
  if (evt.ua) e.ua = String(evt.ua).slice(0, 300);
  if (evt.method) e.method = evt.method;
  if (evt.path) e.path = String(evt.path).slice(0, 300);

  store.add(e);
  broadcast({ type: 'hit', data: e });
  hitCount++;
  if (hitCount <= 20 || hitCount % 25 === 0) {
    log(`[hit] ${e.ip} → :${e.port} (${e.kind}) ${e.geo ? e.geo.country : '定位中'}`);
  }

  if (!geo.isKnown(e.ip)) {
    geo.enqueue(e.ip, (g) => {
      const updated = store.patchGeo(e.id, g);
      if (updated) broadcast({ type: 'geo', id: e.id, geo: g });
    });
  }
  return e;
}

/* ---------------- 诱饵：TCP ---------------- */

const banners = {
  2222: 'SSH-2.0-OpenSSH_8.4p1 Debian-5+deb11u1\r\n',
  2375: 'HTTP/1.1 200 OK\r\nServer: Docker/20.10.7 (linux)\r\nContent-Type: application/json\r\nContent-Length: 26\r\n\r\n{"ApiVersion":"1.41","Os":"linux"}',
  3306: '\x4a\x00\x00\x00\x0a\x38\x2e\x30\x2e\x32\x38\x00',
  3389: '\x03\x00\x00\x13\x0e\xd0\x00\x00\x12\x34\x00\x02\x00\x08\x00\x02\x00\x00\x00',
  5432: 'E',
  5900: 'RFB 003.008\n',
  6379: '-ERR unknown command\r\n',
  9200: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 58\r\n\r\n{"name":"node-1","cluster_name":"elasticsearch","version":{}}',
  11211: 'ERROR\r\n',
  27017: '',
  6667: ':irc.local NOTICE AUTH :*** Looking up your hostname...\r\n',
};

function startTcpTrap(port) {
  const label = trapLabel[port] || '未标注服务';
  const alive = new Map();

  const server = net.createServer((sock) => {
    const ip = normIp(sock.remoteAddress);
    const port_ = sock.remotePort;
    const key = `${ip}:${port_}`;

    record({ ip, port, kind: 'tcp' });

    if (banners[port]) {
      try {
        sock.write(banners[port]);
      } catch {
        /* 对端已断开 */
      }
    }

    let bytes = 0;
    sock.on('data', (d) => {
      bytes += d.length;
      if (bytes > 4096) sock.destroy(); // 只看看有没有人真发东西，不落盘
    });
    sock.on('error', () => {});

    // 挂 4 秒再断，让扫描器认为这是个活着的真实服务
    const t = setTimeout(() => sock.destroy(), 4000);
    alive.set(key, t);
    sock.on('close', () => {
      clearTimeout(t);
      alive.delete(key);
    });
  });

  server.on('error', (e) => log(`[trap] :${port} 启动失败 → ${e.message}`));
  server.listen(port, '0.0.0.0', () => log(`[trap] 监听 :${port}  (${label})`));
  return server;
}

/* ---------------- 诱饵：HTTP ---------------- */

const fakePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Index of /</title></head>
<body style="font-family:ui-monospace,monospace;padding:32px;color:#333">
<h1>It works!</h1>
<hr>
<address>Apache/2.4.52 (Ubuntu) Server</address>
</body></html>`;

function startHttpTrap() {
  const server = http.createServer((req, res) => {
    const ip = normIp(req.socket.remoteAddress);
    record({
      ip,
      port: config.httpTrapPort,
      kind: 'http',
      ua: req.headers['user-agent'],
      method: req.method,
      path: req.url,
    });
    let seen = 0;
    req.on('data', (d) => {
      seen += d.length;
      if (seen > 8192) req.destroy();
    });
    req.on('error', () => {});
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      Server: 'Apache/2.4.52 (Ubuntu)',
    });
    res.end(fakePage);
  });

  server.on('error', (e) => log(`[http-trap] :${config.httpTrapPort} 启动失败 → ${e.message}`));
  server.listen(config.httpTrapPort, '0.0.0.0', () =>
    log(`[http-trap] 监听 :${config.httpTrapPort}  (假 Web 服务，可抓 UA)`)
  );
  return server;
}

/* ---------------- Web 服务（看板） ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
};

function serveSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', home: config.home, stats: store.stats() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 客户端已走 */
    }
  }, 20000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

const web = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);

  if (p === '/api/stats') return json(res, store.stats());
  if (p === '/api/recent') return json(res, store.recent(Math.min(Number(u.searchParams.get('n')) || 80, 500)));
  if (p === '/api/health')
    return json(res, {
      ok: true,
      uptime: Math.round(process.uptime()),
      traps: config.trapPorts,
      geo: geo.stats,
      hits: hitCount,
    });
  if (p === '/api/stream') return serveSse(req, res);

  const rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ---------------- 启动 ---------------- */

web.listen(config.webPort, '0.0.0.0', () =>
  log(`[web] 看板已启动 → http://0.0.0.0:${config.webPort}`)
);

const tcpTrapPorts = config.trapPorts.filter((p) => p !== config.httpTrapPort);
const trapServers = tcpTrapPorts.map(startTcpTrap);
const httpTrap = startHttpTrap();

log(`[sys] 共 ${config.trapPorts.length} 个诱饵端口 + 1 个 Web 看板`);

function shutdown(sig) {
  log(`[sys] 收到 ${sig}，正在退出`);
  geo.persistCache();
  clearInterval(geo.cacheTimer);
  for (const s of trapServers) s.close();
  httpTrap.close();
  web.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log(`[err] ${e.stack || e.message}`));
