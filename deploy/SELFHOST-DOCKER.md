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
| 7 | 本次提交 | AI 助手快捷按钮中文化：`agent-panel.tsx` 里 6 个写死的英文快捷提示词改为中文（总结要点、起草回复、列出待办等）。另注意：助手默认用简体中文回复靠的是邮箱级 `mailbox_agent_settings.instructions` 数据行，不是代码补丁，重建数据库时需重设 |
| 8 | 本次提交 | AI 用量页官方实时用量卡：新增管理员接口 `/api/admin/cf-usage`，用作用域令牌（见下「官方用量统计」）经 GraphQL `aiInferenceAdaptiveGroups` 拉取当日官方 Neurons 用量，前端卡片展示已用/免费额度/按模型明细；费率表（`agent_model_rates`）单价取自官方 REST 模型接口的 `price` 字段 |

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
- **AI 流式净化**：Workers AI 的流式响应会把纯数字 token 序列化为 JSON
  数字（`delta.content` 为 number），触发应用侧严格校验报错。垫片站点
  因此把 `/v1/chat/completions` 单独路由到本机净化服务
  （`deploy/ai-shim/sanitize.js`，systemd 单元 `ai-shim.service`，监听
  127.0.0.1:19320），把 SSE/JSON 中的数字/布尔 content 强制转回字符串
  后再回给应用；Qwen 与 Llama 均有此问题，换模型不能解决。
- **官方用量统计（补丁 8）**：容器 env 另加 `CF_ACCOUNT_ID` 与
  `CF_ANALYTICS_TOKEN`（**独立的作用域令牌**，仅 Account Analytics Read
  + Workers AI Read，账户级）。Workers AI 免费额度 10,000 Neurons/天
  （UTC 00:00 重置），免费计划超额不收费、直接失败到次日。

## 构建容器（两条路）

A. 常规机器（有 Docker 守护进程）：
`docker build .`（仓库根 Dockerfile 即上游多阶段构建），或用根目录
`docker-compose.yml`。

B. 沙盒主机代建（本次生产实际路线：构建机无 Docker 守护进程且出口 TLS
被拦截）：在宿主机完成 `npm ci --ignore-scripts && npm rebuild
better-sqlite3`、`npm run build:node`、生产依赖裁剪（与根 Dockerfile 的
prod-deps 阶段一致；沙盒环境需加 `npm_config_strict_ssl=false`），再用
**`Dockerfile.runtime`** 把产物（node_modules、.next-node、dist、public、
drizzle 等）组装成运行时镜像。两种路线产物等价。**教训（补丁 7/8 上线
时踩过）**：若改走 `docker create/cp/commit` 在目标机上拼镜像，commit
会把构建容器的临时 entrypoint 一并写进镜像（当时是 `sleep 1800`），
容器起来只睡觉不起应用。当前生产靠 `docker-compose.prod.yml` 里的
`entrypoint`/`command` 覆盖项纠正（与原镜像配置一致：
`docker-entrypoint.sh` + `node dist/server.mjs`）；重拼镜像时务必
用 `docker commit --change` 复位 entrypoint/cmd，或保留编排覆盖。

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
