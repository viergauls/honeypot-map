const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  webPort: num(process.env.WEB_PORT, 18080),

  // 诱饵端口：故意挑这些「最常被全网扫描」的服务端口。
  // 注意避开宿主机上已有服务占用的端口（21/22/53/80/111/445/2049/4443/19999...）。
  trapPorts: (process.env.TRAP_PORTS || '2222,2375,3389,5900,6379,9200,1337')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536),

  // 其中这个端口跑一个假 HTTP 服务，能多拿到 User-Agent / 请求路径
  httpTrapPort: num(process.env.HTTP_TRAP_PORT, 1337),

  // 地图上的「我方位置」
  home: {
    name: process.env.HOME_NAME || '我的位置',
    lat: num(process.env.HOME_LAT, 35.0),
    lon: num(process.env.HOME_LON, 105.0),
  },

  dataDir: process.env.DATA_DIR || './data',
  maxEvents: num(process.env.MAX_EVENTS, 8000),

  geo: {
    // ip-api.com 免费版限 45 次/分钟；批量接口一次最多 100 个 IP 且只计 1 次
    endpoint: process.env.GEO_ENDPOINT || 'http://ip-api.com/batch',
    batchSize: num(process.env.GEO_BATCH_SIZE, 80),
    flushMs: num(process.env.GEO_FLUSH_MS, 2500),
    minIntervalMs: num(process.env.GEO_MIN_INTERVAL_MS, 1600),
    timeoutMs: num(process.env.GEO_TIMEOUT_MS, 9000),
    cacheFlushMs: num(process.env.GEO_CACHE_FLUSH_MS, 20000),
  },
};

export const trapLabel = {
  2222: 'SSH (备用端口)',
  2375: 'Docker API',
  3389: '远程桌面 RDP',
  5900: 'VNC',
  6379: 'Redis',
  9200: 'Elasticsearch',
  1337: 'HTTP 服务',
  3306: 'MySQL',
  1433: 'MSSQL',
  5432: 'PostgreSQL',
  11211: 'Memcached',
  27017: 'MongoDB',
  4444: 'Metasploit',
  6667: 'IRC / 僵尸网络 C2',
  31337: '后门常用端口',
};
