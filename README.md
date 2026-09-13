# 蜜獾地图 🦡

跑在家庭 OpenWrt 路由器（公网 `<公网IP>`）上的公网蜜罐攻击实时地图。

家宽公网 IP 每天都被全网扫描器光顾——这个项目把那些扫描流量接住，
解析出攻击源的地理位置（ip-api.com，批量 + 本地缓存），画到一张
实时飞线世界地图上。

## 架构

- **零 npm 依赖**：纯 Node 内置模块（`node:http` / `node:net` / `node:fs`），ECharts 与世界地图数据全部本地化在 `public/vendor/`。
- **后端** `server.js`：
  - 每个诱饵端口一个 `net.createServer`，连上就记一条（不响应协议，只收 DNA）
  - `1337` 端口是假 HTTP，额外抓 User-Agent / Method / Path
  - GeoIP 走 ip-api 批量接口（免费版 45 次/分，批量一次 100 个 IP 只计 1 次），结果落盘缓存，重启不重查
  - 事件 JSONL 持久化到 `data/events.jsonl`（上限 8000 条环形覆盖）
  - `/api/stats`（聚合统计）、`/api/recent`（流水）、`/api/stream`（SSE 实时推送）、`/api/health`
- **前端** `public/`：深色监控大屏，ECharts 世界地图 + 攻击飞线动画 + 国家/端口/惯犯排行 + 实时流水。

## 部署（家庭路由器 <路由器内网地址>）

```bash
# 本机推代码
rsync -av --exclude .git --exclude data --exclude data-dev \
  ~/Projects/honeypot-map/ root@<路由器内网地址>:/opt/apps/honeypot-map/

# 路由器上起容器（复用已有 ylbw-node:22-alpine 镜像，无需 build）
ssh root@<路由器内网地址> 'cd /opt/apps/honeypot-map && docker compose up -d'
```

访问 `http://<DDNS域名>:18080`（DDNS 由 ylbw 容器内自动更新，无需手动维护）。

## 本地开发

```bash
# 本地起服务（避开常用端口，用 12xxx 测试段）
TRAP_PORTS=12222,12375,13389,15900,16379,19200,11337 \
HTTP_TRAP_PORT=11337 WEB_PORT=18080 DATA_DIR=./data-dev \
node server.js

# 敲一下诱饵
nc -z 127.0.0.1 12222
curl -A "zgrab/0.x" http://127.0.0.1:11337/admin.php
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_PORT` | 18080 | Web 地图端口 |
| `TRAP_PORTS` | 2222,2375,3389,5900,6379,9200,1337 | 诱饵端口列表 |
| `HTTP_TRAP_PORT` | 1337 | 其中跑假 HTTP 的端口 |
| `HOME_NAME` / `HOME_LAT` / `HOME_LON` | 我的位置 | 地图上「我方」位置 |
| `DATA_DIR` | ./data | 事件与 GeoIP 缓存目录 |
| `MAX_EVENTS` | 8000 | 内存/文件中保留的最大事件数 |

## ⚠️ 安全提示

诱饵端口会暴露在公网（这正是目的）。**这些端口都是假的**——容器里没有任何
真实服务，扫描者连上只会白等。真正要防的是宿主机上其它 `0.0.0.0` 服务
（netdata / vsftpd / NFS 等），那些与本项目无关，需另行收敛。
