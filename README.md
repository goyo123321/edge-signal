# edge-signal

基于 Cloudflare Workers + Durable Objects 实现的 n2n 控制平面，**替代传统 Supernode 服务器**。

通过 Cloudflare 全球边缘网络提供 WebSocket 信令服务，支持 NAT 打洞协调、TURN 中继和 WebSocket 中继回退，实现**零运维**的异地组网。

## ✨ 特性

- **零运维** — 无需自建服务器，部署到 Cloudflare 即可
- **全球加速** — 利用 Cloudflare Anycast 网络，就近接入
- **P2P 打洞** — 移植 FRP 行为阶梯，提升打洞成功率
- **三级降级** — `P2P → TURN → WS`，保证连接永远可用
- **同 CGNAT 处理** — 同 STUN 出口 IP 时首次允许 hairpin 尝试，失败后强制降级
- **强制降级** — 同 STUN IP 时下发 `force_fallback` 指令
- **动态端口范围** — 扫描范围按两端端口差动态计算（客户端逐级递增：3→10→20→30→60→100）
- **TURN 中继** — 集成 Cloudflare TURN 或自定义 TURN，减少 Worker 消耗
- **双面板** — 公开面板 + 管理面板（Token 保护）
- **设备代号** — 按上线顺序自动分配 A/B/C/D
- **在线/离线统计** — 区分当前在线和断线的设备
- **状态可视化** — `p2p-BD TURN-C ws-D` 格式直观展示连接方式
- **虚拟网段可配** — 通过 `VIRTUAL_NETWORK` 配置任意 IPv4 CIDR
- **状态持久化** — peers 写入 DO Storage，抗 evict
- **自动清理** — 离线设备保留 30 分钟后清理，房间 1 小时无活动清理

## 🏗️ 架构

```
   Edge A ──┐                        ┌── Edge B
            │                        │
            │  WebSocket (WSS)       │
            ▼                        ▼
   ┌────────────────────────────────────┐
   │   Cloudflare Worker (edge-signal)   │
   │   ├─ 信令路由                       │
   │   ├─ NAT 打洞协调                   │
   │   ├─ 下发 TURN 凭证                 │
   │   └─ 中继转发（最后兜底）           │
   └────────────────────────────────────┘
            │
            ├─ 优先级 1: P2P 直连（含 CGNAT hairpin）
            │  Edge A ←──────────────→ Edge B
            │
            ├─ 优先级 2: TURN 中继（不消耗 Worker）
            │  Edge A ──→ TURN ──→ Edge B
            │
            └─ 优先级 3: WebSocket 中继（最后兜底）
               Edge A ──→ Worker ──→ Edge B
```

## 🚀 快速开始

### 前置要求

- Node.js 18+
- Cloudflare 账号（免费版即可）
- Wrangler CLI

### 部署

```bash
git clone https://github.com/goyo123321/edge-signal.git
cd edge-signal
npm install
npx wrangler login
npx wrangler deploy
```

部署成功后输出 Worker URL：

```
https://edge-signal.<你的子域>.workers.dev
```

### 客户端连接

```bash
SIGNALING_URL="wss://edge-signal.<你的子域>.workers.dev" \
  ./n2n-client-linux-amd64 ...
```

客户端参见 [n2n-go-client](https://github.com/goyo123321/n2n-go-client)（PC）或 [n2n-android](https://github.com/goyo123321/n2n-android)（Android）。

## 🚀 通过 GitHub Actions 部署（推荐）

不用本地装 Wrangler，用 GitHub Actions 自动部署。

### 1. 创建 Cloudflare API Token

```
https://dash.cloudflare.com/profile/api-tokens
→ Create Token
→ 选 "Edit Cloudflare Workers" 模板
→ 复制 Token
```

### 2. 获取 Account ID

```
https://dash.cloudflare.com/
→ 右侧栏 "Account ID" → 复制
```

### 3. 配置 GitHub Secrets

```
https://github.com/<你的用户名>/edge-signal/settings/secrets/actions
```

添加：

| Name | Value | 必填 |
|:---|:---|:---|
| `CLOUDFLARE_API_TOKEN` | 步骤1的 Token | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | 步骤2的 Account ID | ✅ |

### 4. 创建 workflow 文件

`.github/workflows/deploy-worker.yml`：

```yaml
name: Deploy edge-signal

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run（只构建不部署）'
        required: false
        type: boolean
        default: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    name: Deploy to Cloudflare Workers
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          else
            npm install
          fi

      - name: Verify credentials
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx wrangler whoami

      - name: Dry run
        if: inputs.dry_run
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx wrangler deploy --dry-run --outdir=dist

      - name: Deploy
        if: ${{ !inputs.dry_run }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx wrangler deploy
```

### 5. 手动触发

```
GitHub → Actions → Deploy edge-signal → Run workflow
```

## 🔐 Token 配置

### ADMIN_TOKEN（管理面板）

```bash
npx wrangler secret put ADMIN_TOKEN
# 输入一个强密码
```

未配置时使用默认值 `12332100`（仅用于开发/测试）。

### CONNECT_TOKEN（可选，保护 /ws/）

```bash
npx wrangler secret put CONNECT_TOKEN
```

配置后，客户端必须带 `CONNECT_TOKEN=xxx` 才能连接。

## 📡 TURN 中继配置

TURN 是三级降级的第二级，**打洞失败时优先走 TURN**（不消耗 Worker 配额）。

### 方式 1：Cloudflare TURN（推荐，1000GB/月免费）

**Step 1：创建 TURN Key**

```
https://dash.cloudflare.com/
→ Realtime → TURN Keys → Create
→ 记录 Key ID 和 API Token（Token 只显示一次）
```

**Step 2：在 Worker 里配置环境变量**

```
Workers & Pages → edge-signal → Settings → Variables and Secrets → Add
```

| Name | Value | 类型 |
|:---|:---|:---|
| `TURN_KEY_ID` | `你的TURN_KEY_ID` | Text |
| `TURN_KEY_API_TOKEN` | `你的API_TOKEN` | **Secret** |

**⚠️ `TURN_KEY_API_TOKEN` 必须选 Secret 类型**（加密存储，Dashboard 显示 `****`）。

### 方式 2：自定义 TURN 服务器

**支持 URL 内嵌凭证**：

```
Workers & Pages → edge-signal → Settings → Variables and Secrets → Add

Name:  TURN_SERVERS
Value: turn://test:test@111.171.194.230:3478
Type:  Text
```

**支持的 URL 格式**：

| 格式 | 解析结果 |
|:---|:---|
| `turn://47.76.28.111:3478` | 无凭证 |
| `turn://test:test@111.171.194.230:3478` | 内嵌 user:pass |
| `turns://user:pass@secure.example.com:5349` | TURN over TLS |
| `turn://a:1@1.2.3.4:3478,turn://b:2@5.6.7.8:3478` | 多个服务器（逗号分隔） |
| `turn://47.76.28.111` | 无端口（补默认 3478）|

**可选：默认凭证**（当 URL 没带凭证时使用）

| Name | Value |
|:---|:---|
| `TURN_USERNAME` | `default_user` |
| `TURN_PASSWORD` | `default_pass` |

### 配置优先级

```
1. Cloudflare TURN（TURN_KEY_ID + TURN_KEY_API_TOKEN 都配了）
   ↓ 都失败/未配
2. 自定义 TURN（TURN_SERVERS 配了）
   ↓ 都失败/未配
3. 客户端自动降级到 WebSocket 中继
```

### 验证 TURN 配置

```bash
curl -s "https://edge-signal.xxx.workers.dev/api/turn-credentials" | jq
```

**未配**：
```json
{"success": false, "error": "TURN not configured", "servers": []}
```

**配了自定义 TURN**：
```json
{
  "success": true,
  "source": "custom",
  "servers": [
    {
      "url": "turn:111.171.194.230:3478",
      "username": "test",
      "password": "test",
      "ttl": 86400
    }
  ]
}
```

**查看部署级 TURN 配置（脱敏，面板用）**：

```bash
curl -s "https://edge-signal.xxx.workers.dev/api/public/turn-config" | jq
```

## 📊 面板

### 公开面板

```
https://edge-signal.<子域>.workers.dev/
```

显示：
- 房间列表（设备数、在线、离线）
- 设备代号（A/B/C/D）
- 虚拟 IP、在线状态
- NAT 类型、连接状态（`p2p-BD TURN-C ws-D`）
- 中继流量

**不显示**：设备名、Client ID、公网地址、操作按钮

### 管理面板

```
https://edge-signal.<子域>.workers.dev/admin?token=<ADMIN_TOKEN>
```

显示：
- 代号 + **设备名**
- **Client ID**
- **HTTP 源 IP / UDP 打洞地址 / 虚拟 IP**（三行）
- **TURN 中继地址**
- 完整连接对端列表
- 中继流量明细

操作：
- **踢出单个设备**（关闭其 WebSocket）
- **清空房间**（有在线设备时被拒绝）
- **清空全部**（自动跳过有在线设备的房间）

## 🔧 监控端点

| 端点 | 说明 | 需 token |
|:---|:---|:---|
| `/api/public/rooms` | 公开房间列表 | ❌ |
| `/api/public/status/<room>` | 公开房间详情（脱敏） | ❌ |
| `/api/public/turn-config` | TURN 配置（脱敏） | ❌ |
| `/api/turn-credentials` | 生成 TURN 凭证 | ❌ |
| `/api/admin/rooms` | 管理房间列表 | ✅ |
| `/api/admin/status/<room>` | 完整房间详情 | ✅ |
| `/api/admin/nathole/<room>` | 打洞协调器状态 | ✅ |
| `/api/admin/kick?room=X&cid=Y` | 踢出设备 | ✅ |
| `/api/admin/clear?room=X` | 清空房间 | ✅ |
| `/api/admin/clear-all` | 清空全部 | ✅ |

## ⚙️ 环境变量

### wrangler.toml 里的 `[vars]`

| 变量 | 默认值 | 说明 |
|:---|:---|:---|
| `NAT_PUNCH_STAGGER_MS` | `1000` | 错峰窗口（毫秒） |
| `NAT_SENDER_DISPATCH_DELAY_MS` | `1000` | sender 指令延迟（毫秒） |
| `VIRTUAL_NETWORK` | `10.64.0.0/24` | 虚拟网段（IPv4 CIDR） |

### 虚拟网段配置

支持 `/16` ~ `/30` 的任意 IPv4 CIDR：

| 网段 | 可用设备数 | 适用场景 |
|:---|:---|:---|
| `10.64.0.0/24` | 253 | 小规模（默认） |
| `100.64.0.0/16` | 65533 | 大规模（CGNAT 段） |
| `172.16.0.0/20` | 4093 | 私有段 |
| `192.168.88.0/24` | 253 | 家宽常用段 |

**修改 `VIRTUAL_NETWORK` 后需要**：
1. 重新部署 Worker
2. **重启所有客户端**——旧的 IP 和路由会被新网段覆盖

### Cloudflare Dashboard 里的变量

见上文「Token 配置」和「TURN 中继配置」。

## 📁 项目结构

```
edge-signal/
├── src/
│   ├── index.ts              # Worker 入口 + TURN 凭证端点 + 公开 API
│   ├── room.ts               # Durable Object: 房间状态 + 打洞协调
│   ├── registry.ts           # Durable Object: 房间注册表
│   └── nathole/
│       ├── ladder.js         # FRP 行为阶梯
│       ├── analyzer.js       # 策略记忆
│       └── coordinator.js    # 打洞协调器
├── public/
│   ├── index.html            # 公开面板
│   ├── app.js
│   ├── admin.html            # 管理面板
│   ├── admin.js
│   └── style.css
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## 🔄 数据生命周期

| 事件 | 行为 |
|:---|:---|
| 客户端连接 | 分配虚拟 IP，写入 storage |
| 客户端断开 | 标记 `online: false`，保留 30 分钟 |
| 30 分钟无活动 | 从 storage 中清理 |
| 房间 1 小时无活动 | 从 registry 中清理 |
| DO 被 evict | peers 从 storage 恢复，代号不变 |
| 客户端重连 | 复用旧记录，虚拟 IP 不变，清空该 peer 的打洞状态 |

## 🧠 NAT 打洞协调

打洞协调器移植自 FRP 的 `nathole` 模块，并修复了若干实战中发现的问题。

### 行为阶梯

每个梯级（rung）对应一组"探测策略"：

| rung | 策略 | 说明 |
|:---|:---|:---|
| 0 | TTL 7，仅 receiver 探测 | 最便宜，对短路径最正确 |
| 1 | TTL 7，双端探测 | 稍强 |
| 2-3 | TTL 4 | 更短的 TTL |
| 4-5 | **无 TTL** | 全路径，长路径唯一能用的 |
| 6-9 | 加 sendDelayMs | 对称 NAT 场景 |

### 关键机制

| 机制 | 说明 |
|:---|:---|
| **梯级签名** | backoff 签名含梯级：`sender->receiver@rung`。梯级变化时立即重试，不受旧退避抑制 |
| **in-flight 去重** | 派发后写入 in-flight 表，10s 内不重复派发 |
| **InProgress 刷新** | 客户端收到指令立即上报 InProgress，服务端刷新 in-flight 窗口，覆盖 `sendDelayMs` 期间 |
| **首次交叉校验** | 首次成功时校验客户端自报的 `p2pStatus`；通过后 `everValidated=true`，后续成功不再校验 |
| **成功退役** | **双方**都不在 P2P 且超过 30s 宽限期时，清空成功记录，重新协调 |
| **退避上限** | 60s（不是 300s，避免无意义的等待） |
| **失败惩罚** | -2（与成功 +2 对称） |
| **tie-break** | rung 0 > rung 4/5 > 其他 |

### 同 CGNAT 场景处理

**关键问题**：两端 STUN 出口 IP 相同时（同 CGNAT 后面的两个映射），hairpin NAT 大部分运营商不支持，但仍有一小部分支持。需要区分两种情况：

| 场景 | 处理 |
|:---|:---|
| **同 STUN IP + 首次** | 允许一次 hairpin 尝试（部分 CGNAT 支持） |
| **同 STUN IP + 已失败过** | 下发 `force_fallback` 强制降级到 TURN/WS |

### 单向 P2P 的处理

**问题**：A 的 probe 命中了 B，B 的 probe 因丢包没到 A。B 单方面报 `state=3` 会导致服务端认为 pair 已完成，A 永远收不到指令。

**修复**：
- **客户端侧**：`hasTrafficFromTarget(peerID, since)` 只检查目标 peer 的 `lastRecvAt`，而不是 `hasTrafficFromAny`（只比对 IP，同 CGNAT 时任何来自同出口 IP 的包都误判成功）
- **服务端侧**：`coordinate()` 的 `bothSucceeded` 要求 `aState === 3 && bState === 3` 才跳过协调

### 端口扫描范围

**问题**：HardNAT 下两端上报的 `pubSocket` 端口是"发到 STUN 时"的端口，但两端 STUN 时刻不同——CGNAT 中间可能为其他连接分配了几十个端口，导致真实出口端口差距很大。

**解法**：扫描范围必须至少覆盖这个差距。

```javascript
// NAT 行为差异（来自客户端上报的 portsDifference 之差）
const natDiff = Math.abs(
  senderFeature.portsDifference - receiverFeature.portsDifference
);

// 两端 pubSocket 的实际端口差
const portGap = Math.abs(senderPort - receiverPort);

// 有效范围 = max(natDiff, portGap) + 缓冲，上限 100
let halfWidth = Math.max(natDiff, portGap) + PORTS_RANGE_NARROW;
if (halfWidth > 100) halfWidth = 100;
```

**客户端侧分阶段扫描**：

服务端下发 `portsRangeFrom` / `portsRangeTo` 作为参考。客户端**实际执行**按分级递增：

| 层 | 范围 | 本轮增量端口数 | 累计 |
|:---|:---|:---|:---|
| 1 | ±3 | 7 | 7 |
| 2 | ±10 | 14 | 21 |
| 3 | ±20 | 20 | 41 |
| 4 | ±30 | 20 | 61 |
| 5 | ±60 | 60 | 121 |
| 6 | ±100 | 80 | 201 |

**每层连发 3 次**（覆盖丢包），**层间 100ms**。

- 端口差小（±3）：第 1 层命中，**~300ms**
- 端口差中等（±20）：第 3 层命中，**~900ms**
- 端口差大（±100）：第 6 层碰运气，**~1.8s**
- 完全失败：跑满 6 层，**~1.8s** 后放弃，走 TURN

### 调试端点

```
GET /api/admin/nathole/<room>?token=<ADMIN_TOKEN>
```

返回：
- `backoff`：所有 pair 的退避窗口
- `punch`：所有 pair 的打洞状态（含 `aState` / `bState` / `aP2PStatus` / `bP2PStatus` / `everValidated`）
- `inflight`：所有 in-flight 条目

## 🚨 限制

### 规模

| 指标 | 上限 |
|:---|:---|
| 单房间设备数 | 取决于 `VIRTUAL_NETWORK`（默认 253） |
| 推荐规模 | 10 台以内 |
| 打洞协调复杂度 | O(N²) |

### 免费版配额

- **每天 10 万次请求**（Worker）
- **DO Storage 每天 1000 次写操作**

### TURN 免费额度

- **Cloudflare TURN：1000GB/月**
- 超出后 $0.05/GB

## 🔐 安全建议

- **务必**配置 `ADMIN_TOKEN`（不要用默认 `12332100`）
- 生产环境建议配置 `CONNECT_TOKEN`
- TURN 凭证含密码时，**必须**用 Secret 类型存储
- 定期轮换 token

## ❓ 常见问题

### Q: 面板显示 `--` 连接状态？

**客户端没上报 `connection_status`，或者 `relayMgr.states` 为空**。

排查：

1. **Worker 日志搜 `[Room] p2p_metadata from`** —— 是否有客户端的 metadata 上报
2. **Worker 日志搜 `[NAT] pair-`** —— 协调器是否派发了打洞指令
3. **如果完全没有协调器日志** —— 客户端 `natType` 是 `unknown`，被 `classifyNat` 跳过

**修复**：确认客户端和 `coordinator.js` 都是最新版。

### Q: 两端状态不一致（A=p2p，B=TURN）？

**单向打洞成功**——A 的 probe 命中 B，但 B 回发给 A 的 probe 丢包了。

**修复**：
- 客户端用 `hasTrafficFromTarget` 替代 `hasTrafficFromAny`
- 服务端用 `bothSucceeded` 替代 `anySucceeded`

### Q: 同 STUN 出口 IP 时疯狂打洞？

**`coordinator.js` 太旧**，还在无脑派发打洞指令。

**最新版逻辑**：

1. **首次遇到** → 允许一次 hairpin 尝试
2. **已失败过** → 下发 `force_fallback` 强制降级

**修复**：重新部署 `coordinator.js`。

### Q: 打洞一直失败，attempts 很大？

**端口扫描范围太窄**。看客户端日志：

```
[NAT-HOLE] 公网候选 7 个（阶段 2）    ← 太窄
[NAT-HOLE] 公网候选 13 个（阶段 2）   ← 分阶段第 1 层
[NAT-HOLE] 公网候选 61 个（阶段 2）   ← 分阶段第 4 层
```

**修复**：`coordinator.js` 的 `halfWidth` 计算应包含 `portGap`，重新部署。

### Q: 打洞指令下发但客户端没反应？

**客户端 AAR / 二进制太旧**——缺 `nat_hole_instruction` 处理，或缺 `scheduleFallbackTimer`。

**排查**：

1. **客户端日志搜 `[NAT-HOLE] 开始打洞`** —— 有就是客户端收到了指令
2. **Worker 日志搜 `[Room] → xxx 下发 nat_hole_instruction`** —— 有就是服务端发出去了

**如果服务端发了、客户端没收到** → 客户端 WS 断线或版本问题。

### Q: TURN 服务器额度用尽？

**客户端会自动降级到 WS 中继**，不影响使用。

**建议**：升级 Cloudflare TURN 套餐，或加自建 coturn（配置 `TURN_SERVERS`）。

### Q: Worker 请求额度用尽？

**打洞失败时每条数据都走 Worker 中继**，消耗很快。

**修复**：
1. 优先让 P2P 打通（hairpin）
2. 配置 TURN（`TURN_SERVERS`），让流量走 TURN 而不是 Worker

### Q: `natType` 显示不一致（一端 HardNAT、一端 EasyNAT）？

**客户端版本不一致**——一端是旧版（单样本判 EasyNAT），另一端是新版（单样本判 unknown）。

**修复**：两端升级到同一版本客户端。

### Q: 同一对设备一会走 P2P 一会走 TURN？

**CGNAT 端口漂移**。客户端上报的 `pubSocket` 端口在打洞时已经过期。

**修复**：客户端**启用 UDP 保活**（每 5 秒刷新 STUN 映射），让端口保持稳定。检查客户端版本。

### Q: 房间清理不掉？

**房间有在线设备时，清空会被拒绝**（返回 409）。

**手动清理**：

```bash
# 强制清空（不管在线设备）
curl -X POST "https://edge-signal.xxx.workers.dev/api/admin/clear?room=myroom&force=1&token=<ADMIN_TOKEN>"
```

或先踢掉在线设备：

```bash
curl -X POST "https://edge-signal.xxx.workers.dev/api/admin/kick?room=myroom&cid=<ClientID>&token=<ADMIN_TOKEN>"
```

### Q: Worker 日志怎么查看？

**方式 1：实时日志**

```bash
npx wrangler tail
```

**方式 2：Dashboard**

```
https://dash.cloudflare.com/
→ Workers & Pages → edge-signal → Logs
```

**关键日志**：

```
[Room] p2p_metadata from xxx: natType=... pub=... multiExit=...
[NAT] xxx 同 STUN 出口 IP (120.239.134.13)，允许一次 hairpin 尝试
[NAT] xxx 跳过：同 STUN 出口 IP 已尝试失败，标记强制降级
[Room] → xxx 下发 force_fallback (1 peers)
[Room] → xxx 下发 nat_hole_instruction role=1 target=...
```

### Q: 怎么验证 TURN 配置生效？

```bash
curl -s "https://edge-signal.xxx.workers.dev/api/public/turn-config" | jq
```

**未配**：
```json
{
  "enabled": false,
  "source": "none",
  "servers": [],
  "priority": []
}
```

**配了自定义 TURN**：
```json
{
  "enabled": true,
  "source": "custom",
  "servers": [{"url": "turn:111.171.194.230:3478"}],
  "priority": ["custom"]
}
```

### Q: 面板上设备代号（A/B/C/D）会变吗？

**不会**。代号按 `registeredAt` 时间排序，**只要 DO Storage 不丢，代号就不变**。

DO 被 evict 后，从 storage 恢复 → 代号保持。

**唯一会变的情况**：
- 设备超过 30 分钟离线被清理
- 房间被手动清空

## 📄 License

MIT

## 🔗 相关项目

- [n2n-android](https://github.com/goyo123321/n2n-android) — Android 客户端
- [n2n-go-client](https://github.com/goyo123321/n2n-go-client) — 跨平台客户端
