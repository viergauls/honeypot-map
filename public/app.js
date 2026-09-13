const $ = (s) => document.querySelector(s);

const state = {
  home: { name: '我的位置', lat: 35.0, lon: 105.0 },
  events: [],
  markers: [],
  lines: [],
  maxEvents: 220,
  maxMarkers: 260,
  maxLines: 48,
  total: 0,
};

let chart = null;
let flushTimer = null;
let firstHit = false;

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const PORT_LABEL = {
  2222: 'SSH', 2375: 'Docker API', 3389: 'RDP', 5900: 'VNC',
  6379: 'Redis', 9200: 'Elasticsearch', 1337: 'HTTP',
  3306: 'MySQL', 1433: 'MSSQL', 5432: 'PostgreSQL',
  11211: 'Memcached', 27017: 'MongoDB', 6667: 'IRC/C2',
};

/* ---------------- ECharts ---------------- */

function baseOption() {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10,17,27,.96)',
      borderColor: '#1c2836',
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: '#e6edf7', fontSize: 12 },
      extraCssText: 'border-radius:8px;backdrop-filter:blur(4px)',
      formatter: (p) => {
        const d = p.data || {};
        if (p.seriesId === 'home') {
          return `<b style="color:#22d3ee">${esc(state.home.name)}</b><br/><span style="color:#78899f">本机所在地</span>`;
        }
        if (p.seriesId === 'points') {
          const loc = [d.country, d.city].filter(Boolean).join(' · ') || '位置未知';
          const lines = [
            `<b style="color:#ff7a45">${esc(d.ip)}</b>`,
            `<span style="color:#78899f">${esc(loc)}</span>`,
          ];
          if (d.isp) lines.push(`<span style="color:#4d5d73">${esc(d.isp)}</span>`);
          lines.push(`命中端口 :${esc(d.port)} · ${esc(PORT_LABEL[d.port] || '未知服务')}`);
          if (d.hits > 1) lines.push(`<span style="color:#ff4d4f">该 IP 已命中 ${d.hits} 次</span>`);
          return lines.join('<br/>');
        }
        return '';
      },
    },
    geo: {
      map: 'world',
      roam: true,
      zoom: 1.15,
      center: [108, 30],
      scaleLimit: { min: 0.8, max: 12 },
      itemStyle: { areaColor: '#0f1a27', borderColor: '#22364f', borderWidth: 0.6 },
      emphasis: { itemStyle: { areaColor: '#17293d' }, label: { show: false } },
      select: { disabled: true },
    },
    series: [
      {
        id: 'lines',
        type: 'lines',
        coordinateSystem: 'geo',
        zlevel: 2,
        effect: {
          show: true,
          period: 4.2,
          trailLength: 0.32,
          symbol: 'arrow',
          symbolSize: 5,
          color: '#ff7a45',
        },
        lineStyle: { color: '#ff4d4f', width: 0.7, opacity: 0.3, curveness: 0.22 },
        data: [],
      },
      {
        id: 'points',
        type: 'effectScatter',
        coordinateSystem: 'geo',
        zlevel: 3,
        effect: { show: true, brushType: 'stroke', scale: 2.6, period: 3.6 },
        symbolSize: 6,
        itemStyle: { color: '#ff4d4f', shadowBlur: 9, shadowColor: 'rgba(255,77,79,.85)' },
        data: [],
      },
      {
        id: 'home',
        type: 'effectScatter',
        coordinateSystem: 'geo',
        zlevel: 4,
        effect: { show: true, brushType: 'stroke', scale: 3.2, period: 2.8 },
        symbolSize: 9,
        itemStyle: { color: '#22d3ee', shadowBlur: 14, shadowColor: 'rgba(34,211,238,.9)' },
        label: {
          show: true,
          formatter: () => state.home.name,
          position: 'top',
          color: '#22d3ee',
          fontSize: 11,
          fontWeight: 500,
        },
        data: [],
      },
    ],
  };
}

function renderChart() {
  if (!chart) return;
  chart.setOption({
    series: [
      { id: 'lines', data: state.lines },
      {
        id: 'points',
        data: state.markers.map((m) => ({
          name: m.country,
          value: [m.lon, m.lat, 1],
          ip: m.ip,
          country: m.country,
          city: m.city,
          isp: m.isp,
          port: m.port,
          hits: m.hits,
        })),
      },
      {
        id: 'home',
        data: [{ name: state.home.name, value: [state.home.lon, state.home.lat, 1] }],
      },
    ],
  });
  $('#mapEmpty').classList.toggle('show', state.markers.length === 0);
}

/* ---------------- 数据流 ---------------- */

function addMarker(e) {
  const existing = state.markers.find((m) => m.ip === e.ip);
  if (existing) {
    existing.hits += 1;
    existing.port = e.port;
    existing.lon = e.geo.lon;
    existing.lat = e.geo.lat;
  } else {
    state.markers.push({
      ip: e.ip,
      lon: e.geo.lon,
      lat: e.geo.lat,
      country: e.geo.country,
      city: e.geo.city,
      isp: e.geo.isp,
      port: e.port,
      hits: 1,
    });
    if (state.markers.length > state.maxMarkers) state.markers.shift();
  }

  state.lines.push({
    coords: [
      [e.geo.lon, e.geo.lat],
      [state.home.lon, state.home.lat],
    ],
  });
  if (state.lines.length > state.maxLines) state.lines.shift();
}

function ingest(e, animate = true, prepend = true) {
  if (prepend) {
    state.events.unshift(e);
    if (state.events.length > state.maxEvents) state.events.pop();
  } else {
    state.events.push(e);
  }
  if (e.geo && typeof e.geo.lat === 'number') addMarker(e);
  if (animate) scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    renderChart();
    renderFeed();
  }, 170);
}

function applyGeo(id, geo) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  e.geo = geo;
  if (geo && typeof geo.lat === 'number') {
    addMarker(e);
    scheduleFlush();
  }
  renderFeed();
}

/* ---------------- 渲染 ---------------- */

function renderStats(s) {
  state.total = s.total || 0;
  $('#kTotal').textContent = s.total ?? 0;
  $('#k24').textContent = s.last24h ?? 0;
  $('#kIps').textContent = s.uniqueIps ?? 0;
  $('#kCc').textContent = s.uniqueCountries ?? 0;

  renderRanks(
    '#rankCc',
    s.countries || [],
    (i) => `${esc(i.name)}${i.cc && i.cc !== '??' ? `<em>${esc(i.cc)}</em>` : ''}`
  );

  renderRanks(
    '#rankPort',
    (s.ports || []).slice(0, 12),
    (i) => `:${i.port}<em>${esc(PORT_LABEL[i.port] || '未知服务')}</em>`
  );

  renderRanks(
    '#rankSrc',
    s.topSources || [],
    (i) => `<span style="font-family:ui-monospace,monospace">${esc(i.ip)}</span>`
  );
}

function renderRanks(sel, items, label) {
  const el = $(sel);
  if (!items.length) {
    el.innerHTML = '<p class="empty">暂无数据</p>';
    return;
  }
  const max = Math.max(...items.map((i) => i.count));
  el.innerHTML = items
    .map(
      (i) => `<div class="rank">
        <div class="rank-bar" style="width:${((i.count / max) * 100).toFixed(1)}%"></div>
        <span class="rank-label">${label(i)}</span>
        <span class="rank-count">${i.count}</span>
      </div>`
    )
    .join('');
}

function renderFeed() {
  const el = $('#feed');
  const list = state.events.slice(0, 60);
  if (!list.length) {
    el.innerHTML = '<p class="empty">等待第一个敲门的人…</p>';
    $('#feedCount').textContent = '0 条';
    return;
  }
  $('#feedCount').textContent = `${state.events.length} 条`;

  el.innerHTML = list
    .map((e) => {
      const g = e.geo;
      const loc = g ? [g.country, g.city].filter(Boolean).join(' · ') || '位置未知' : '定位中…';
      const cc = g && g.cc && g.cc !== '??' ? `<span class="cc">${esc(g.cc)}</span>` : '';
      const ua = e.ua ? `<span class="ua" title="${esc(e.ua)}">${esc(e.ua)}</span>` : '';
      return `<div class="hit">
        <span class="t">${fmtTime(e.ts)}</span>
        <span class="ip">${esc(e.ip)}</span>
        <span class="loc">${esc(loc)}${cc}${ua}</span>
        <span class="port">:${esc(e.port)}</span>
      </div>`;
    })
    .join('');
}

/* ---------------- 连接 ---------------- */

function setLive(on, text) {
  const el = $('#live');
  el.classList.toggle('on', !!on);
  el.querySelector('span').textContent = text || (on ? '实时' : '已断开');
}

function connect() {
  const es = new EventSource('/api/stream');

  es.onopen = () => setLive(true, '实时');

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      if (msg.home) {
        state.home = { ...state.home, ...msg.home };
        $('#homeLabel').textContent = state.home.name;
        renderChart();
      }
      if (msg.stats) renderStats(msg.stats);
    } else if (msg.type === 'hit') {
      ingest(msg.data);
      if (!firstHit) {
        firstHit = true;
        refreshStats();
      }
    } else if (msg.type === 'geo') {
      applyGeo(msg.id, msg.geo);
    }
  };

  es.onerror = () => setLive(false, '重连中');
}

let statsTimer = null;
function refreshStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = null;
    try {
      const s = await fetch('/api/stats').then((r) => r.json());
      renderStats(s);
    } catch {
      /* 忽略 */
    }
  }, 1200);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  let worldJson = null;
  try {
    const r = await fetch('/vendor/world.json');
    worldJson = await r.json();
  } catch {
    $('#mapEmpty').innerHTML = '<b>地图数据加载失败</b><span>请检查 /vendor/world.json 是否可访问</span>';
    $('#mapEmpty').classList.add('show');
    return;
  }

  echarts.registerMap('world', worldJson);
  chart = echarts.init($('#map'), null, { renderer: 'canvas' });
  chart.setOption(baseOption());
  window.addEventListener('resize', () => chart.resize());

  try {
    const [stats, recent, health] = await Promise.all([
      fetch('/api/stats').then((r) => r.json()),
      fetch('/api/recent?n=120').then((r) => r.json()),
      fetch('/api/health').then((r) => r.json()).catch(() => null),
    ]);
    renderStats(stats);
    for (const e of [...recent].reverse()) ingest(e, false, false);
    state.events.reverse();
    firstHit = state.events.length > 0;
    if (health && Array.isArray(health.traps)) {
      document.title = `蜜獾地图 · ${health.traps.length} 个诱饵端口`;
    }
  } catch {
    /* 首次启动可能没有历史，忽略 */
  }

  renderChart();
  renderFeed();
  connect();

  // 定期刷新统计（排行榜靠它更新）
  setInterval(refreshStats, 12000);
}

boot();
