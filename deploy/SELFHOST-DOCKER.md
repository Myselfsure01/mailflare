# 自建 Docker 部署说明（本 fork）

本 fork 是上游 mailflare 的自托管部署版：2026-11-03 起以 Docker 容器方式
单独运行（不再使用 Cloudflare Workers 运行时），域名邮箱、网盘、AI 助手
全部自建。本文档汇总本 fork 相对上游的全部修改与部署方法，便于重建与升级。

## 相对上游的补丁（fork patches）

| # | 提交 | 内容 |
|---|------|------|
| 1 | 6e07568 | Team 授权解锁：自托管单机部署直接授予 Team 权益（许可证状态由数据行 `license_settings = team/active` 承载；**切勿在管理页点「停用许可证」**） |
| 2 | 096758c | 远程图片安全检查修复：DoH 解析结果只接受 IP 字面量，不再把 CNAME 别名误判为内网地址 |
| 3 | a21aa07 | 被阅读器拦截的远程图片显示中性占位图（CSS 占位） |
| 4 | 431b599 | 同上改为真实图源占位图（96×96 PNG data URI） |
| 5 | a578b32 | 新建邮箱对话框下拉框双层边框修复 |
| 6 | 本次提交 | **收信中继（deploy/cloudflare-email-relay）**：签名头 JSON 中的非 ASCII 字符先转义为 `\uXXXX` 再签名/发送。根因：发件人中文显示名在 Worker→源站链路上被按 Latin-1 误解码，字节变化导致 HMAC 校验 401，全部入站邮件被拒。应用侧 JSON 解析后得到同一映射，无需改动 |

另有应用内更新工作流（bbce0cf，Workers 时期遗留）：自建 Docker 版中应用内
更新按设计不可用，忽略即可。**注意：若将来套用上游更新，整树覆盖会冲掉
上述补丁**——补丁标记（源码内 `PATCH n` 注释）为巡检依据，升级后需逐项核对。

## 架构

- **收信**：域名 MX → Cloudflare Email Routing（三条规则全部指向
  `mailflare-email-relay` Worker）→ 中继以 HMAC V2 签名 POST 原始邮件到
  源站 `https://<origin-host>/api/inbound` → nginx 反代 → 容器 `127.0.0.1:3000`。
  容器侧 `INBOUND_REQUIRE_SIGNED_HEADERS=1` 强制验签；中继与容器共用
  `INBOUND_WEBHOOK_SECRET`（两处必须一致）。
- **发信**：应用内按域名走 Resend（发信子域 `send.<domain>` 的 SPF/DKIM/MX
  由 Resend 校验页管理）。
- **Cloudflare 集成**：容器 env `CF_TOKEN` 使用**限定单个 zone 的作用域
  令牌**（Zone Read、DNS Write、Email Routing Rules 读写、Zone Settings
  Read、Zone DNS Settings Read；账户级 Email Routing Addresses 读写、
  Account Rules Read）。切勿把 Global API Key 放进容器。
- **AI 助手**：Docker 版没有 Workers 的 AI 绑定，原生 `cloudflare` 供应商
  永远无法配置；改走 Workers AI **REST**：作用域令牌作 `AI_API_KEY`，
  供应商切为 `compatible/custom` 且 base URL 与 env `AI_BASE_URL` 完全一致
  （应用只在两者相等时借用 env 密钥）。Workers AI 的 OpenAI 兼容端点对
  `GET /v1/models` 回 405，故在本机 nginx 加垫片站点提供静态模型目录并
  转发 `/v1/*`，见 `deploy/ai-models-shim.nginx.conf`。

## 构建容器（两条路）

A. 常规机器（有 Docker 守护进程）：
`docker build .`（仓库根 Dockerfile 即上游多阶段构建），或用根目录
`docker-compose.yml`。

B. 沙盒主机代建（本次生产实际路线：构建机无 Docker 守护进程且出口 TLS
被拦截）：在宿主机完成 `npm ci --ignore-scripts && npm rebuild
better-sqlite3`、`npm run build:node`、生产依赖裁剪（与根 Dockerfile 的
prod-deps 阶段一致；沙盒环境需加 `npm_config_strict_ssl=false`），再用
**`Dockerfile.runtime`** 把产物（node_modules、.next-node、dist、public、
drizzle 等）组装成运行时镜像。两种路线产物等价。

## 部署

1. 复制 `.env.docker.example` 为 `.env.docker` 并填值（该文件已被
   .gitignore 排除，**严禁入库**）。
2. 用 `docker-compose.prod.yml` 启动：仅映射 `127.0.0.1:3000`，内存上限
   512m，前置 nginx 反代（含 `/api/realtime` 的 WebSocket 升级与
   `client_max_body_size 40m`）。
3. 数据卷 `mailflare-data`（SQLite + blobs）即全部数据，备份此卷即可；
   回滚保留一组旧 Workers 部署（应用 Worker + D1/R2）作为冷备。

## 运维注意

- 中继 Worker 的部署包由中继源码 esbuild 打包；改中继后需重新打包发布，
  并用 `wrangler secret put` 复核 `MAILFLARE_URL` 与 `INBOUND_WEBHOOK_SECRET`。
- 防重放：签名被中继侧记录，同一封邮件重放会被源站以 409 拒绝，属预期。
- 垃圾过滤：URLhaus（abuse.ch）+ RDAP 域名年龄 + 内置规则；
  Spamhaus DQS 因官方拒绝公共解析器查询暂不可用（字段留空）。
