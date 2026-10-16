# edge-signal

基于 Cloudflare Workers + Durable Objects 实现的 n2n 控制平面，**替代传统 Supernode 服务器**。

通过 Cloudflare 全球边缘网络提供 WebSocket 信令服务，支持 NAT 打洞协调、TURN 中继和 WebSocket 中继回退，实现**零运维**的异地组网。

---

## 🌐 四端协同全景

`edge-signal` 是整个系统的**信令中枢**，配合三个客户端实现跨平台异地组网：

```
              ┌───────────────────────────────────────────┐
              │      edge-signal (Cloudflare Worker)      │
              │                                           │
              │  ├─ 信令路由（WebSocket）                 │
              │  ├─ NAT 打洞协调（coordinator.js）        │
              │  ├─ TURN 凭证下发                         │
              │  ├─ 房间/peer 状态存储（Durable Objects） │
              │  └─ WS 中继（最后兜底）                   │
              └──────────────┬────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
   n2n-go-client       n2n-termux          n2n-android
   (TUN 模式)          (SOCKS5 + 包转发)    (VpnService)
   Linux/macOS         Android              Android
   Windows/路由器      Termux                APK
   需 root             无 root              无 root

              LAN / P2P / TURN / WS  --  完全互通
```

### 三端能力对比

| 维度 | n2n-go-client | n2n-termux | n2n-android |
|:---|:---|:---|:---|
| **平台** | Linux / macOS / Windows / 路由器 | Android Termux | Android APK |
| **数据面** | TUN | SOCKS5 + 包转发器 | VpnService + SOCKS5 |
| **主动访问（TCP）** | ✅ | ✅ | ✅ |
| **主动访问（UDP）** | ✅ | ❌ | ✅ |
| **主动访问（ICMP）** | ✅ | ❌ | ✅ |
| **被动接受（TCP）** | ✅ | ✅ | ✅ |
| **被动接受（UDP）** | ✅ | ✅ | ✅ |
| **被动接受（ICMP）** | ✅ | ✅ | ✅ |
| **权限** | root | 无 root | 无 root |

**服务端对三端平等对待**——同一套 WebSocket 协议，同一套打洞协调逻辑，同一个 TURN 凭证分发。

### 服务端在各降级级中的作用

| 降级级 | 服务端角色 | 消耗 |
|:---|:---|:---|
| **LAN 直连** | 仅信令（交换 LAN 候选） | 极少 |
| **P2P 打洞** | 信令 + 打洞协调（下发指令） | 极少 |
| **TURN 中继** | 仅下发 TURN 凭证 | 极少 |
| **WS 中继** | **实际转发每个数据包** | 高（消耗 Worker 配额） |

**核心设计**：服务端**主动避免**数据面流量，尽量让客户端走 P2P 或 TURN。

---

## ✨ 特性

- **零运维** — 无需自建服务器，部署到 Cloudflare 即可
- **全球加速** — 利用 Cloudflare Anycast 网络，就近接入
- **P2P 打洞** — 移植 FRP 行为阶梯，提升打洞成功率
- **三级降级** — `P2P → TURN → WS`，保证连接永远可用
- **LAN 直连** — 客户端上报 LAN 候选，同 WiFi 场景直接内网通信
- **同 CGNAT 处理** — 同 STUN 出口 IP 时首次允许 hairpin 尝试，失败后下发 `force_fallback`
- **强制降级** — 同 STUN IP 已失败时下发 `force_fallback` 指令
- **动态端口范围** — 扫描范围按两端端口差动态计算
- **多端点扫描** — assisted + LAN + raddr 同时下发，提升命中率
- **Cloudflare TURN 支持** — 原生集成 Cloudflare Calls TURN，1000GB/月免费
- **自定义 TURN** — 支持自建 coturn（UDP/TCP transport）
- **双面板** — 公开面板 + 管理面板（Token 保护）
- **设备代号** — 按上线顺序自动分配 A/B/C/D
- **在线/离线统计** — 区分当前在线和断线的设备
- **状态可视化** — `p2p-BD TURN-C ws-D` 格式直观展示连接方式
- **虚拟网段可配** — 通过 `VIRTUAL_NETWORK` 配置任意 IPv4 CIDR
- **状态持久化** — peers 写入 DO Storage，抗 evict
- **自动清理** — 离线设备保留 30 分钟后清理，房间 1 小时无活动清理

---

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

---

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

**三端客户端**：

| 客户端 | 平台 | 数据面 | 说明 |
|:---|:---|:---|:---|
| [n2n-go-client](https://github.com/goyo123321/n2n-go-client) | Linux/macOS/Windows/路由器 | TUN | 需 root/管理员 |
| [n2n-termux](https://github.com/goyo123321/n2n-termux) | Android Termux | SOCKS5 + 包转发 | 无 root，**双向互通** |
| [n2n-android](https://github.com/goyo123321/n2n-android) | Android APK | VpnService | 无 root |

**三者完全互通**——同一房间内，任意两端可直接互访虚拟 IP。

---

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

---

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

配置后，客户端必须带 `CONNECT_TOKEN=xxx` 才能连接。三端客户端都支持。

---

## 📡 TURN 中继配置

TURN 是三级降级的第二级，**打洞失败时优先走 TURN**（不消耗 Worker 配额）。

### 方式 1：Cloudflare TURN（推荐，1000GB/月免费）

**Step 1：创建 TURN Key**

```
1. 打开 Cloudflare Dashboard
   https://dash.cloudflare.com/

2. 进入你的账户 → 左侧菜单 Realtime → TURN Keys

3. 点击 Create
   - Name: edge-signal-turn（随便起）

4. ★ 弹窗会一次性显示两个值，必须立即复制：
   - Token ID   ← 这是 TURN_KEY_ID
   - API Token  ← 这是 TURN_KEY_API_TOKEN

   ⚠️ API Token 只显示一次，刷新页面就没了。
      如果忘了，只能删除这个 TURN Key 重新创建。
```

**Step 2：配置到 Worker**

**方式 A：Wrangler CLI（推荐）**

```bash
cd edge-signal

# 设置 TURN Key ID
npx wrangler secret put TURN_KEY_ID
# 粘贴上面复制的 Token ID

# 设置 TURN Key API Token
npx wrangler secret put TURN_KEY_API_TOKEN
# 粘贴上面复制的 API Token
```

**方式 B：Cloudflare Dashboard**

```
Workers & Pages → edge-signal → Settings
  → Variables and Secrets → Add

Name:  TURN_KEY_ID
Value: <Token ID>
Type:  Text

Name:  TURN_KEY_API_TOKEN
Value: <API Token>
Type:  Secret        ← ★ 必须选 Secret，加密存储
```

**Step 3：部署**

```bash
npx wrangler deploy
```

**Step 4：验证**

```bash
curl -s "https://edge-signal.xxx.workers.dev/api/turn-credentials" | jq
```

**配置正确**：

```json
{
  "success": true,
  "source": "cloudflare",
  "servers": [
    {
      "url": "turn:turn.cloudflare.com:3478?transport=udp",
      "username": "bc91b63e...",
      "password": "ebd71f1d...",
      "ttl": 86400
    },
    {
      "url": "turn:turn.cloudflare.com:3478?transport=tcp",
      "username": "bc91b63e...",
      "password": "ebd71f1d...",
      "ttl": 86400
    }
  ]
}
```

**`"source": "cloudflare"` 是关键** —— 说明真的在调用 Cloudflare TURN API 并返回了公网 relay 地址。

**⚠️ 常见错误**

| 错误现象 | 原因 | 修复 |
|:---|:---|:---|
| `"source": "custom"` | Cloudflare 返回解析失败（旧版代码把 `iceServers` 当数组） | 升级到最新 `index.ts` |
| `"source": "none"` | 未配置 TURN | 按上文配置 |
| `"success": false, "error": "TURN not configured"` | 环境变量名写错 | 确认是 `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` |
| HTTP 401 | `TURN_KEY_API_TOKEN` 值不对 | 重新创建 TURN Key 并替换 |
| 客户端 relay 是 `172.16.x.x` 之类内网地址 | 用的是自定义 TURN（coturn 未配 `external-ip`） | 修 coturn 或切 Cloudflare TURN |

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

### ⚠️ 自建 coturn 必须配 `external-ip`

如果你的 TURN 服务器在**云厂商 NAT 网关后面**（如阿里云、腾讯云、大部分 VPS），必须在 `/etc/turnserver.conf` 里加：

```conf
# 格式：公网IP/私网IP
external-ip=<你的公网IP>/<你的私网IP>
```

**示例**：

```conf
external-ip=47.76.28.111/172.16.96.4
```

**不配的后果**：客户端拿到的 relay 地址是 **`172.16.x.x` 之类的内网地址**，公网根本不可达 → TURN 中继完全不可用。

**改完重启**：

```bash
sudo systemctl restart coturn
```

**验证**：客户端日志里 relay 地址应该是**公网 IP**：

```
[TURN-Lite] ✅ Allocation 成功: relay=47.76.28.111:xxxxx    ← 公网可达
```

### 配置优先级

```
1. Cloudflare TURN（TURN_KEY_ID + TURN_KEY_API_TOKEN 都配了）
   ↓ 调用失败
2. 自定义 TURN（TURN_SERVERS 配了）
   ↓ 都失败/未配
3. 客户端自动降级到 WebSocket 中继
```

**注意**：如果同时配了 Cloudflare TURN 和自定义 TURN，Cloudflare TURN **优先**；只有它返回空时才 fallback 到自定义 TURN。

### 查看当前 TURN 配置（脱敏）

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

**配了 Cloudflare TURN**：

```json
{
  "enabled": true,
  "source": "cloudflare",
  "servers": [],
  "priority": ["cloudflare"]
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

---

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

### 连接类型徽章

服务端面板和 Android App 使用同一套徽章：

| 徽章 | 颜色 | 含义 |
|:---|:---|:---|
| `p2p-A` | 🟢 绿底 | P2P 直连（数据面已验证） |
| `p2p-avail-A` | 🟡 黄底虚线 | P2PAvailable 中间态（握手成功，数据面未验证） |
| `TURN-A` | 🔵 蓝底 | TURN 中继 |
| `ws-A` | 🟡 黄底 | WS 中继（最后兜底） |

---

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

---

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

---

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

---

## 🔄 数据生命周期

| 事件 | 行为 |
|:---|:---|
| 客户端连接 | 分配虚拟 IP，写入 storage |
| 客户端断开 | 标记 `online: false`，保留 30 分钟 |
| 30 分钟无活动 | 从 storage 中清理 |
| 房间 1 小时无活动 | 从 registry 中清理 |
| DO 被 evict | peers 从 storage 恢复，代号不变 |
| 客户端重连 | 复用旧记录，虚拟 IP 不变，清空该 peer 的打洞状态 |

---

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
| **InProgress 刷新** | 客户端收到指令立即上报 InProgress，服务端刷新 in-flight 窗口 |
| **首次交叉校验** | 首次成功时校验客户端自报的 `p2pStatus`；通过后 `everValidated=true` |
| **成功退役** | 双方都不在 P2P 且超过 30s 宽限期时，清空成功记录，重新协调 |
| **退避上限** | 60s（不是 300s，避免无意义的等待） |
| **失败惩罚** | -2（与成功 +2 对称） |
| **tie-break** | rung 0 > rung 4/5 > 其他 |

### 同 CGNAT 场景处理

**关键问题**：两端 STUN 出口 IP 相同时（同 CGNAT 后面的两个映射），hairpin NAT 大部分运营商不支持，但仍有一小部分支持。需要区分两种情况：

| 场景 | 处理 |
|:---|:---|
| **同 STUN IP + 首次** | 允许一次 hairpin 尝试（部分 CGNAT 支持） |
| **同 STUN IP + 已失败过** | 下发 `force_fallback` 强制降级到 TURN/WS |

**实现逻辑**（`coordinator.js`）：

```javascript
const aIp = extractIP(a.pubSocket);
const bIp = extractIP(b.pubSocket);
if (aIp && bIp && aIp === bIp) {
  const alreadyFailed =
    (prevPunch && (prevPunch.aState === 2 || prevPunch.bState === 2)) ||
    (this.failCounts.get(key) || 0) > 0;

  if (alreadyFailed) {
    // 下发 force_fallback
    forceFallbacks.set(aKey, new Set([bKey]));
    forceFallbacks.set(bKey, new Set([aKey]));
    continue;
  }
  // 首次允许 hairpin
}
```

**客户端行为**：三端收到 `force_fallback` 后立即 `ForceFallback` → TURN/WS，不再重复打洞。

### 单向 P2P 的处理

**问题**：A 的 probe 命中了 B，B 的 probe 因丢包没到 A。B 单方面报 `state=3` 会导致服务端认为 pair 已完成，A 永远收不到指令。

**修复**：
- **客户端侧**：`hasTrafficFromTarget(peerID, since)` 只检查目标 peer 的 `lastRecvAt`
- **服务端侧**：`coordinate()` 的 `anySucceeded` 允许任一端成功即停止协调
- **已 P2P 时**：客户端主动上报 `p2p_status=3`，让服务端 `punchState` 记录成功状态，停止重发指令

### 端口扫描范围

**问题**：HardNAT 下两端上报的 `pubSocket` 端口是"发到 STUN 时"的端口，但两端 STUN 时刻不同——CGNAT 中间可能为其他连接分配了几十个端口，导致真实出口端口差距很大。

**解法**：

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

### 多端点扫描

打洞指令同时下发四类候选：

1. **`targetAssistedEndpoints`** — STUN 反射的多个公网映射
2. **`targetLanEndpoints`** — 对端上报的 LAN 地址（同 WiFi 场景）
3. **`targetPubSocket`** — 对端上报的主公网地址
4. **raddr** — 客户端观测到的对端源地址（本机侧）

客户端按 **LAN → assisted → raddr → pubSocket** 的顺序扫描，命中即停。

### 调试端点

```
GET /api/admin/nathole/<room>?token=<ADMIN_TOKEN>
```

返回：
- `backoff`：所有 pair 的退避窗口
- `punch`：所有 pair 的打洞状态
- `inflight`：所有 in-flight 条目

---

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

---

## 🔐 安全建议

- **务必**配置 `ADMIN_TOKEN`（不要用默认 `12332100`）
- 生产环境建议配置 `CONNECT_TOKEN`
- TURN 凭证含密码时，**必须**用 Secret 类型存储
- 定期轮换 token

---

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
- 客户端用 `hasTrafficFromTarget` 替代 `hasTrafficAny`
- 服务端用 `anySucceeded` 替代 `bothSucceeded`
- 已 P2P 一端主动上报 `p2p_status=3`，让服务端记录成功

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

### Q: 客户端每 15 秒收到一次 `nat_hole_instruction`（重复指令）？

**客户端已 P2P 但没告诉服务端**。

**原因**：客户端收到指令前已经通过 PING/PONG 建立了 P2P，直接 `return`，服务端 `punchState.aState/bState` 一直是 0，`anySucceeded=false`，每 15 秒重发一次。

**修复**：客户端在跳过指令时**主动上报** `p2p_status=3`：

```go
if e.relayMgr.GetState(instr.TargetMac) == ConnP2P {
    e.reportP2PStatus(instr.TargetMac, 3)
    return
}
```

**验证**：客户端日志 `[NAT-HOLE] 跳过指令 target=xxx（已 P2P），上报 p2p_status=3` **只出现一次**。

### Q: TURN 服务器额度用尽？

**客户端会自动降级到 WS 中继**，不影响使用。

**建议**：升级 Cloudflare TURN 套餐，或加自建 coturn（配置 `TURN_SERVERS`）。

### Q: Worker 请求额度用尽？

**打洞失败时每条数据都走 Worker 中继**，消耗很快。

**修复**：
1. 优先让 P2P 打通（hairpin）
2. 配置 TURN，让流量走 TURN 而不是 Worker

### Q: `natType` 显示不一致（一端 HardNAT、一端 EasyNAT）？

**客户端版本不一致**——一端是旧版（单样本判 EasyNAT），另一端是新版（单样本判 unknown）。

**修复**：两端升级到同一版本客户端。

### Q: 同一对设备一会走 P2P 一会走 TURN？

**CGNAT 端口漂移**。客户端上报的 `pubSocket` 端口在打洞时已经过期。

**修复**：客户端**启用 UDP 保活**（每 5 秒刷新 STUN 映射）。检查客户端版本。

**服务端对应处理**：`room.ts` 里只在**出口 IP 变化**时清空打洞状态，端口变化不清：

```typescript
const oldIp = this.extractIp(oldPubSocket);
const newIp = this.extractIp(publicEndpoint);
if (oldIp && newIp && oldIp !== newIp) {
  this.coordinator.clearPairStateFor(from);
}
```

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

### Q: `curl /api/turn-credentials` 返回 `"source": "custom"`，但我配了 Cloudflare TURN？

**症状**：明明设置了 `TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN`，但 `source` 一直是 `custom`。

**原因**：旧版 `index.ts` 里 `generateCloudflareTURN` 有个 bug：

```typescript
for (const ice of data.iceServers || []) {  // ← iceServers 是对象，不是数组
```

**`for...of` 对对象会抛 `TypeError`**，或者 `iceServers` 为 undefined 时循环不执行 → `servers` 为空 → fallback 到 `custom`。

**修复**：

1. 用最新版 `index.ts`（本仓库 main 分支）替换
2. `npx wrangler deploy`
3. 重新验证：

```bash
curl -s "https://xxx.workers.dev/api/turn-credentials" | jq '.source'
# 应该输出 "cloudflare"
```

### Q: 客户端日志里 TURN relay 是 `172.16.x.x` 之类内网地址？

**症状**：

```
[TURN-Lite] ✅ Allocation 成功: relay=172.16.96.4:58882
```

**`172.16.x.x` 是 RFC 1918 私有地址**，公网不可达。

**原因**：你用的是**自建 coturn**，且**没配 `external-ip`**。

**修复**：

```bash
ssh root@<你的 TURN 服务器 IP>
sudo nano /etc/turnserver.conf
# 加一行：
external-ip=<公网IP>/<私网IP>
# 例如：
external-ip=47.76.28.111/172.16.96.4
sudo systemctl restart coturn
```

**验证**：

```bash
# 客户端重启后，relay 应该是公网地址
[TURN-Lite] ✅ Allocation 成功: relay=47.76.28.111:xxxxx
```

**替代方案**：切换到 Cloudflare TURN（本文「方式 1」），`172.16.x.x` 问题彻底消失。

### Q: `TURN_KEY_API_TOKEN` 忘了怎么办？

**无法找回**——Cloudflare 只显示一次。

**修复**：

1. Cloudflare Dashboard → Realtime → TURN Keys
2. **删除**旧的 TURN Key
3. **Create** 一个新的
4. **立即复制** Token ID 和 API Token
5. 更新 Worker 环境变量：

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler deploy
```

### Q: 面板上设备代号（A/B/C/D）会变吗？

**不会**。代号按 `registeredAt` 时间排序，**只要 DO Storage 不丢，代号就不变**。

DO 被 evict 后，从 storage 恢复 → 代号保持。

**唯一会变的情况**：
- 设备超过 30 分钟离线被清理
- 房间被手动清空

---

## 🌐 三端客户端协同说明

服务端对**所有客户端平等对待**——无论 PC、Termux 还是 Android APK，都通过同一套 WebSocket 协议通信。

### 三端差异对照

| 维度 | n2n-go-client | n2n-termux | n2n-android |
|:---|:---|:---|:---|
| 运行环境 | Linux/macOS/Windows/路由器 | Android Termux | Android APK |
| 数据面 | TUN | SOCKS5 + 包转发 | VpnService |
| 权限 | root/管理员 | 无 root | 无 root |
| **主动 TCP** | ✅ | ✅ | ✅ |
| **主动 UDP** | ✅ | ❌ | ✅ |
| **主动 ICMP** | ✅ | ❌ | ✅ |
| **被动 TCP** | ✅ | ✅ | ✅ |
| **被动 UDP** | ✅ | ✅ | ✅ |
| **被动 ICMP** | ✅ | ✅ | ✅ |
| 上报 `lanEndpoints` | ✅ | ✅ | ✅ |
| 上报 `assistedEndpoints` | ✅ | ✅ | ✅ |

### 服务端配置对三端的影响

| 配置 | PC | Termux | Android |
|:---|:---|:---|:---|
| `VIRTUAL_NETWORK` | ✅ 自动适配 | ✅ | ✅ |
| `CONNECT_TOKEN` | ✅ 支持 | ✅ | ✅ |
| `ADMIN_TOKEN` | 不影响 | 不影响 | 不影响 |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | ✅ 通过 API 获取 | ✅ | ✅ |
| `TURN_SERVERS` | ✅ | ✅ | ✅ |
| `NAT_PUNCH_STAGGER_MS` | 服务端控制 | 同 | 同 |
| `NAT_SENDER_DISPATCH_DELAY_MS` | 服务端控制 | 同 | 同 |

### 互访矩阵（三端 × 三端）

| 主动方 → 被动方 | 服务端行为 | 数据面 |
|:---|:---|:---|
| PC → Termux | 打洞协调 | N2NS 帧（PC 侧 TUN 发出） |
| PC → Android | 打洞协调 | 裸 IPv4 包（双 TUN） |
| Termux → PC | 打洞协调 | N2NS 帧（Termux 侧 SOCKS5 触发） |
| Termux → Android | 打洞协调 | N2NS 帧 |
| Android → PC | 打洞协调 | 裸 IPv4 包（双 TUN） |
| Android → Termux | 打洞协调 | 裸 IPv4 包 + packet_forwarder |

**所有 6 种组合完全互通**。

### WS 中继路径的兼容

当打洞和 TURN 都失败时，三端降级到 **WS 中继**。此路径使用两套协议：

1. **`SendBinary`** — 原始 IPv4 包（用于 TUN ↔ TUN / TUN ↔ packet_forwarder 的纯数据面转发）
2. **`app_stream_*`** — 应用层 TCP 隧道（用于 SOCKS5 ↔ TUN 或跨类型访问）

**三端都实现了这两套协议**，所以 WS 中继路径也完全互通。

**ICMP 特殊处理**：由于单向 P2P 常见（CGNAT 打洞后 A→B 通、B→A 断），Termux 端将 **ICMP 响应强制走 WS 中继**（牺牲延迟换可靠），确保 ping 稳定。

---

## 📄 License

MIT

## 🔗 相关项目

- [n2n-go-client](https://github.com/goyo123321/n2n-go-client) — 跨平台客户端（桌面 / 路由器 / 服务器）
- [n2n-termux](https://github.com/goyo123321/n2n-termux) — Android Termux SOCKS5 客户端（双向互通）
- [n2n-android](https://github.com/goyo123321/n2n-android) — Android APK 客户端（VpnService）
