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

### 四级降级与状态机

服务端主动避免数据面流量，尽量让客户端走 P2P 或 TURN：

| 优先级 | 连接方式 | 服务端角色 | 消耗 | 延迟 |
|:---|:---|:---|:---|:---|
| 1 | **LAN 直连** | 仅信令（交换 LAN 候选） | 极少 | <5ms |
| 2 | **P2P 打洞** | 信令 + 打洞协调 | 极少 | 10-50ms |
| 3 | **TURN 中继** | 仅下发 TURN 凭证 | 极少 | 30-100ms |
| 4 | **WS 中继** | 实际转发每个数据包 | 高（消耗 Worker 配额） | 100-300ms |

客户端状态机（`RelayManager`）：

```
Unknown → ConnLAN        (收到 LAN 数据帧 / LAN Punch/ACK / 打洞命中 LAN)
        → ConnP2PAvailable (收到公网 Punch/ACK / 打洞握手成功)
        → ConnP2P        (收到公网数据帧 / 公网 PONG)
        → ConnTURN       (打洞失败 / 30s 无流量 / peer-via-turn/ws)
        → ConnRelay      (TURN 未就绪)

ConnLAN  → ConnP2P       (60s 无 LAN 流量 / LAN 发送失败)
ConnP2P  → ConnTURN/Relay (30s 无流量 / peer-via-turn/ws)
```

**状态机与数据流完全统一**——TCP/UDP/ICMP 都走 `SendToPeer`，所有接收来源（UDP/TURN/WS）统一处理，所有状态变化经 `Mark*` 函数。

---

## ✨ 特性

### 核心
- **零运维** — 无需自建服务器，部署到 Cloudflare 即可
- **全球加速** — 利用 Cloudflare Anycast 网络，就近接入
- **LAN 直连** — 客户端上报 LAN 候选，同 WiFi 场景直接内网通信（<5ms）
- **P2P 打洞** — 移植 FRP 行为阶梯，提升打洞成功率
- **四级降级** — `LAN → P2P → TURN → WS`，保证连接永远可用

### NAT 打洞
- **端口扫描范围动态计算** — `max(natDiff, portGap) + 缓冲`，上限 10000
- **多端点扫描** — assisted + LAN + raddr 同时下发，提升命中率
- **同 CGNAT 处理** — 同 STUN 出口 IP 时首次允许 hairpin，失败后 `force_fallback`
- **首轮错峰** — 最新注册的 peer 留 NAT 映射建立时间
- **状态机双向确认** — 客户端上报 `p2pStatus`，服务端交叉校验

### LAN 直连（v2.0 新增）
- **lanSubnets 上报** — 客户端上报 CIDR，多 LAN 场景准确判断
- **cidrOverlaps 重叠判定** — 服务端优先按子网重叠判断，**双 WAN / 多 AP 上行**也能走 LAN
- **ConnLAN 独立状态** — LAN 和公网 P2P 分开管理
- **LAN 60s 超时** — LAN 无流量 60s 才降级到公网 P2P（不是 TURN）
- **LAN 2s 保活豁免** — LAN 不对抗 WiFi 省电，节省流量

### 网络切换（v2.0 新增）
- **onLinkPropertiesChanged 网关检测** — WiFi1 → WiFi2（同类型网络）也能毫秒级感知
- **NetworkCallback 类型检测** — WiFi ↔ Cellular ↔ Ethernet
- **OnNetworkChanged 状态重置** — 清 P2P/LAN 状态、UDPAddr、LanEndpoints，保留 TURN/WS
- **network_changed 广播** — 服务端清协调状态 + 通知其他 peer
- **peer_network_changed 处理** — 其他 peer 清该 peer 的 LAN 地址

### TURN
- **Cloudflare TURN** — 原生集成，1000GB/月免费
- **自定义 TURN** — 支持自建 coturn（UDP/TCP/RFC6062）
- **actualSource 追踪** — 面板显示「配置 source」和「实际 source」不一致时黄色提示
- **TTL 限制** — `/api/turn-credentials` 的 ttl clamp 到 `[600, 604800]`
- **5s 超时** — Cloudflare TURN API 失败时 fallback，不 hold Worker

### 混合房间
- **协议能力协商** — 客户端上报 `features`，服务端自动协商 WS 中继帧格式（N2NW / N2NA / 文本）
- **新→旧 N2NW 保护** — 服务端检查目标端 `n2nw`，不支持则丢弃 + 警告（旧版静默丢包）
- **新旧客户端混合房间零丢包**

### 安全与配额
- **裸 IPv4 源 IP 校验** — 防 VIP 欺骗
- **app_stream_* 强制 to** — 防广播
- **app_stream_data 64KB 限制**
- **reportToRegistry 500ms 去抖** — 防 10 设备频繁重连打爆 DO Storage
- **runCoordination 500ms 节流** — 降 O(N²) 评估频率
- **SOCKS5 端口冲突检测** — `Listen()` 失败返回 error，UI 显示启动失败
- **TURN TTL 上限** — 防恶意超大 ttl 请求

### 面板
- **双面板** — 公开面板 + 管理面板（Token 保护）
- **连接类型徽章** — `lan-XX` / `p2p-XX` / `p2p-avail-XX` / `TURN-XX` / `ws-XX`
- **协议能力 chips** — `n2na` / `n2nw` 显示
- **设备代号** — 按上线顺序自动分配 A/B/C/D
- **状态可视化** — `lan-BD TURN-C ws-D` 格式直观展示连接方式
- **房间清理** — 房间完全空时 5 分钟内清 registry（不再显示"0 个设备"）

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
            ├─ 优先级 1: LAN 直连（同 WiFi）
            │  Edge A ←──────────────→ Edge B
            │
            ├─ 优先级 2: P2P 直连（含 CGNAT hairpin）
            │  Edge A ←──────────────→ Edge B
            │
            ├─ 优先级 3: TURN 中继（不消耗 Worker）
            │  Edge A ──→ TURN ──→ Edge B
            │
            └─ 优先级 4: WebSocket 中继（最后兜底）
               Edge A ──→ Worker ──→ Edge B
```

---

## 🚀 快速开始

### 前置要求

- Node.js 18+
- Cloudflare 账号（免费版即可）
- Wrangler CLI ≥ 3.50（推荐 `^3.114.0`）

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

TURN 是四级降级的第三级，**打洞失败时优先走 TURN**（不消耗 Worker 配额）。

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

npx wrangler secret put TURN_KEY_ID
# 粘贴上面复制的 Token ID

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
| 请求 hang 30 秒 | Cloudflare TURN API 慢 | 已修复，5 秒超时 fallback |
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
   ↓ 调用失败（5 秒超时 / HTTP 错误 / 空响应）
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
  "actualSource": "none",
  "actualSourceAt": 0,
  "servers": [],
  "priority": []
}
```

**配了 Cloudflare TURN（API 正常）**：

```json
{
  "enabled": true,
  "source": "cloudflare",
  "actualSource": "cloudflare",
  "actualSourceAt": 1729651200000,
  "servers": [],
  "priority": ["cloudflare"]
}
```

**配了 Cloudflare TURN 但 API 失败（已 fallback 到自定义）**：

```json
{
  "enabled": true,
  "source": "cloudflare",
  "actualSource": "custom",
  "actualSourceAt": 1729651200000,
  "servers": [{"url": "turn:111.171.194.230:3478"}],
  "priority": ["cloudflare", "custom"]
}
```

**管理面板会显示黄色提示** `TURN Cloudflare (实际: custom)` —— 说明配置层面是 Cloudflare，但最近一次实际成功用的是 custom。

### TTL 限制

`/api/turn-credentials` 的 `?ttl=` 参数会被 **clamp 到 `[600, 604800]`**（10 分钟 ~ 7 天），超出范围自动修正。

---

## 🔌 协议能力协商（features）

客户端在 `p2p_metadata` 里上报 `features` 数组，服务端据此决定 WS 中继的帧格式。

| feature | 含义 | 引入版本 |
|:---|:---|:---|
| `n2nw` | 支持 IPv4 二进制数据面（N2NW 帧） | v1.0.24 |
| `n2na` | 支持 app_stream 二进制数据面（N2NA 帧） | 最新 |

### 混合房间行为

服务端按**目标端**是否支持 `n2na` / `n2nw` 决定转发格式：

| 发送方 | 接收方 | 服务端行为 |
|:---|:---|:---|
| 新 | 新 | 二进制转发（N2NA/N2NW，节省 ~27% 带宽） |
| 新 | 旧（无 n2na） | 解码转 `app_stream_data` 文本 |
| 新 | 旧（无 n2nw） | **丢弃 + 警告**（旧客户端只懂裸 IPv4） |
| 旧 | 新 | 文本（新客户端兼容） |
| 旧 | 旧 | 文本 |

**零丢包**——新旧客户端可在同一房间通信，服务端自动协商。

### 向后兼容保证

- 旧客户端不上报 `features` → 服务端视为 `[]` → 全走文本降级，**行为与升级前完全一致**
- 服务端**不需要等待任何客户端先升级**——部署后即生效
- 新旧客户端可以在同一房间共存，互不影响

### 验证 features 上报

```bash
curl -s "https://<worker>/api/admin/status/<room>?token=<ADMIN_TOKEN>" | jq '.peers[] | {code, features}'
```

**新客户端**返回：

```json
{"code": "A", "features": ["n2na", "n2nw"]}
```

**旧客户端**返回：

```json
{"code": "B", "features": []}
```

---

## 🔄 网络切换处理（v2.0 新增）

### WiFi ↔ Cellular 切换

Android 客户端通过 `ConnectivityManager.NetworkCallback.onAvailable` 检测网络类型变化：

```
WiFi → Cellular / Cellular → WiFi / 任意 → Ethernet
    ↓
N2nController.notifyNetworkChanged("cellular")
    ↓
Go 层 Edge.OnNetworkChanged()
    ├─ 清空 failCounts / natHoleActive
    ├─ RelayManager.ResetP2PStates → ConnLAN/ConnP2P/ConnP2PAvailable → ConnUnknown
    ├─ 清空 peers[*].UDPAddr / lastLANRecvAt / lastPublicRecvAt / LanEndpoints
    ├─ 取消所有 fallbackTimers / p2pAvailTimers
    ├─ 立即 reportMetadata（绕过 30s 节流）
    └─ WS 发 network_changed → 服务端
        ↓
    服务端 coordinator.clearPairStateFor + 清 peer.pubSocket/... + 广播 peer_network_changed
        ↓
    其他 peer 收到 peer_network_changed → 清该 peer 的 UDPAddr/LanEndpoints
```

### WiFi1 → WiFi2（同类型网络）切换

**问题**：`onAvailable` 只在「网络可用」时触发，WiFi 间切换 `type` 都是 `"wifi"`，旧版 `type == prev` 直接 return → 状态机停留在 `ConnLAN` → 持续丢包 30-60 秒。

**修复**：`ConnectivityManager.NetworkCallback.onLinkPropertiesChanged` 检测**网关变化**：

```
WiFi1 (192.168.1.1) → WiFi2 (192.168.2.1)
    ↓
onLinkPropertiesChanged 检测到网关变化
    ↓
N2nController.notifyNetworkChanged("gateway:192.168.2.1")
    ↓
（同上 OnNetworkChanged 流程，毫秒级触发）
```

**跳过 VPN 自身接口**：`onLinkPropertiesChanged` 先检查 `TRANSPORT_VPN`，VPN 接口（tun0）变化时不触发，避免循环。

### 切换后的收敛

| 时刻 | 状态机 | 路径 |
|:---|:---|:---|
| T+0 | `ConnLAN/ConnP2P → ConnUnknown`（毫秒级） | WS 兜底，不丢包 |
| T+0~T+5s | `ConnUnknown` | WS 中继 |
| T+5s | STUN 拿到新公网地址 | — |
| T+5s | 服务端重新协调打洞 | — |
| T+5s~T+10s | 收敛到 `ConnLAN` / `ConnP2P` / `ConnTURN` | 正常通信 |

**从「T+60s 卡在假 P2P」变成「T+5~10s 收敛」**。

---

## 🌐 双 WAN / 多 AP 上行场景（v2.0 新增）

### 场景

- A、B 物理上在同一 LAN `192.168.1.0/24`
- A 走 WAN1（公网 IP `1.1.1.1`），B 走 WAN2（公网 IP `2.2.2.2`）
- 双 WAN 路由 / 多 AP 各自上行

### 旧版问题

`shouldShareLan` 只比较 `_publicIp`：

```js
if (aIp !== bIp) return false;   // 双 WAN → false → lanEndpoints 被过滤
```

客户端 `notePeerCommon` 无法匹配 LAN 源地址 → 打洞失败 → TURN/WS。

### 新版修复

**服务端 `shouldShareLan` 优先看 `lanSubnets` 重叠**：

```js
function shouldShareLan(a, b) {
  const aSubnets = a.lanSubnets || [];
  const bSubnets = b.lanSubnets || [];
  if (aSubnets.length > 0 && bSubnets.length > 0) {
    for (const sa of aSubnets) {
      for (const sb of bSubnets) {
        if (cidrOverlaps(sa, sb)) return true;  // 子网重叠 → 同 LAN
      }
    }
    return false;
  }
  // 兜底：旧客户端不上报 lanSubnets，退回公网 IP 相同
  return aIp === bIp;
}
```

**客户端 `ensureTargetPeer` 从打洞指令补充 `LanEndpoints`**：

```go
// 即使 joined 的 lanEndpoints 为空，nat_hole_instruction 的 targetLanEndpoints
// 是完整列表（未经 shouldShareLan 过滤），写回后 notePeerCommon 能匹配 LAN 包
if len(instr.TargetLanEndpoints) > 0 && len(p.LanEndpoints) == 0 {
    p.LanEndpoints = sortLANByAffinity(instr.TargetLanEndpoints, prefixes)
}
```

**效果**：双 WAN / 多 AP 上行场景，T+1s 就能走 LAN（`lan-XX` 徽章），延迟从 TURN 的 30-100ms 降到 LAN 的 <5ms。

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
- NAT 类型、连接状态（`lan-BD p2p-C TURN-D ws-E`）
- 中继流量

**不显示**：设备名、Client ID、公网地址、操作按钮、features

### 管理面板

```
https://edge-signal.<子域>.workers.dev/admin?token=<ADMIN_TOKEN>
```

显示：
- 代号 + **设备名**
- **Client ID**
- **HTTP 源 IP / UDP 打洞地址 / 虚拟 IP**（三行）
- **TURN 中继地址**
- **协议能力 chips**（NAT 类型列下方显示 `n2na` / `n2nw`）
- 完整连接对端列表
- 中继流量明细
- **TURN 实际 source**（配置 vs 实际不一致时黄色提示）

操作：
- **踢出单个设备**（关闭其 WebSocket）
- **清空房间**（有在线设备时被拒绝）
- **清空全部**（自动跳过有在线设备的房间）

### 连接类型徽章

服务端面板和 Android App 使用同一套徽章：

| 徽章 | 颜色 | 含义 | 延迟 |
|:---|:---|:---|:---|
| `lan-A` | 🟢 深绿底亮绿字 | LAN 直连（同 WiFi 且子网重叠） | <5ms |
| `p2p-A` | 🟢 绿底 | P2P 直连（数据面已验证） | 10-50ms |
| `p2p-avail-A` | 🟡 黄底虚线 | P2PAvailable 中间态（握手成功，数据面未验证） | — |
| `TURN-A` | 🔵 蓝底 | TURN 中继 | 30-100ms |
| `ws-A` | 🟡 黄底 | WS 中继（最后兜底） | 100-300ms |

### 协议能力徽章（管理面板专属）

| 徽章 | 颜色 | 含义 |
|:---|:---|:---|
| `n2na` | 🟢 绿底 | 支持 app_stream 二进制数据面 |
| `n2nw` | 🔵 蓝底 | 支持 IPv4 二进制数据面 |
| `无能力上报` | 灰色 | 旧客户端未上报 features |

---

## 🔧 监控端点

| 端点 | 说明 | 需 token |
|:---|:---|:---|
| `/api/public/rooms` | 公开房间列表 | ❌ |
| `/api/public/status/<room>` | 公开房间详情（脱敏） | ❌ |
| `/api/public/turn-config` | TURN 配置（脱敏 + actualSource） | ❌ |
| `/api/turn-credentials` | 生成 TURN 凭证（ttl clamp 到 7 天） | ❌ |
| `/api/admin/rooms` | 管理房间列表 | ✅ |
| `/api/admin/status/<room>` | 完整房间详情（含 features） | ✅ |
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
│   ├── room.ts               # Durable Object: 房间状态 + 打洞协调 + N2NA 转发
│   ├── registry.ts           # Durable Object: 房间注册表
│   └── nathole/
│       ├── ladder.js         # FRP 行为阶梯
│       ├── analyzer.js       # 策略记忆
│       └── coordinator.js    # 打洞协调器（pairPairs 修复）
├── public/
│   ├── index.html            # 公开面板
│   ├── app.js
│   ├── admin.html            # 管理面板
│   ├── admin.js
│   └── style.css
├── wrangler.toml
├── package.json              # wrangler ^3.114.0
└── tsconfig.json
```

---

## 🔄 数据生命周期

| 事件 | 行为 |
|:---|:---|
| 客户端连接 | 分配虚拟 IP，写入 storage |
| 客户端断开 | 标记 `online: false`，保留 30 分钟 |
| 30 分钟无活动 | 从 storage 中清理 |
| 房间完全空 | 5 分钟内主动清 registry（`alarm` 触发） |
| 房间 1 小时无活动 | 从 registry 中清理（兜底） |
| DO 被 evict | peers 从 storage 恢复，代号不变，features 保持 |
| 客户端重连 | 复用旧记录，虚拟 IP 不变，**清空 features/connections/lanEndpoints 等** |

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
| **pairPairs 修复** | 旧版 `paired` 是 peer 维度，N≥3 房间只有 A-B 配对。新版 `pairPairs` 是 pair 维度，每对只评估一次，删除所有 break |
| **梯级签名** | backoff 签名含梯级：`sender->receiver@rung`。梯级变化时立即重试 |
| **in-flight 去重** | 派发后写入 in-flight 表，10s 内不重复派发 |
| **InProgress 刷新** | 客户端收到指令立即上报 InProgress，服务端刷新 in-flight 窗口 |
| **首次交叉校验** | 首次成功时校验客户端自报的 `p2pStatus`；通过后 `everValidated=true` |
| **成功退役** | 双方都不在 P2P/LAN 且超过 30s 宽限期时，清空成功记录 |
| **LAN 跳过 force_fallback** | 已是 LAN 的对跳过同 STUN IP 强制降级 |
| **退避上限** | 60s（不是 300s，避免无意义的等待） |
| **失败惩罚** | -2（与成功 +2 对称） |
| **tie-break** | rung 0 > rung 4/5 > 其他 |

### 同 CGNAT 场景处理

**关键问题**：两端 STUN 出口 IP 相同时，hairpin NAT 大部分运营商不支持，但仍有一小部分支持。

| 场景 | 处理 |
|:---|:---|
| **同 STUN IP + 首次** | 允许一次 hairpin 尝试 |
| **同 STUN IP + 已失败过** | 下发 `force_fallback` 强制降级 |
| **同 STUN IP + 已是 LAN** | **跳过**（`coordinator.js` 检查 `connections`） |

### 单向 P2P 的处理

**问题**：A 的 probe 命中 B，B 的 probe 因丢包没到 A。B 单方面报 `state=3` 会导致服务端认为 pair 已完成。

**三层修复**：

1. **客户端**：`hasTrafficFromTarget(peerID, since)` 只检查目标 peer 的 `lastRecvAt`
2. **服务端**：`coordinate()` 的 `anySucceeded` 允许任一端成功即停止协调
3. **TURN 帧降级**：TURN 收到对端帧时，`viaTURN=true + cur == ConnP2P/ConnLAN` → `ForceFallback("peer-via-turn")`

### 端口扫描范围

**问题**：HardNAT 下两端上报的 `pubSocket` 端口是"发到 STUN 时"的端口，但两端 STUN 时刻不同。

**解法**：

```javascript
// NAT 行为差异（来自客户端上报的 portsDifference 之差）
const natDiff = Math.abs(
  senderFeature.portsDifference - receiverFeature.portsDifference
);

// 两端 pubSocket 的实际端口差
const portGap = Math.abs(senderPort - receiverPort);

// 有效范围 = max(natDiff, portGap) + 缓冲，上限 10000
let halfWidth = Math.max(natDiff, portGap) + PORTS_RANGE_NARROW;
if (halfWidth > 10000) halfWidth = 10000;
```

**客户端侧分阶段扫描**（`fullScanTiers = [3, 10, 20, 30, 60, 100, 300, 1000, 3000, 10000]`）：

| 层 | 范围 | 本轮增量端口数 | 累计 |
|:---|:---|:---|:---|
| 1 | ±3 | 7 | 7 |
| 2 | ±10 | 14 | 21 |
| 3 | ±20 | 20 | 41 |
| 4 | ±30 | 20 | 61 |
| 5 | ±60 | 60 | 121 |
| 6 | ±100 | 80 | 201 |
| 7 | ±300 | 400 | 601 |
| 8 | ±1000 | 1400 | 2001 |
| 9 | ±3000 | 4000 | 6001 |
| 10 | ±10000 | 14000 | 20001 |

**每层连发 3 次**（覆盖丢包），**层间 100ms**。当 `half > 500` 时每层只发 1 次（大范围扫描避免耗时过长）。

- 端口差小（±3）：第 1 层命中，**~300ms**
- 端口差中等（±20）：第 3 层命中，**~900ms**
- 端口差大（±100）：第 6 层碰运气，**~1.8s**
- 端口差超大（±1000+）：第 8-10 层碰运气，**~2-3s**
- 完全失败：跑满 10 层，**~3s** 后放弃，走 TURN

### 多端点扫描

打洞指令同时下发四类候选：

1. **`targetAssistedEndpoints`** — STUN 反射的多个公网映射
2. **`targetLanEndpoints`** — 对端上报的 LAN 地址
3. **`targetPubSocket`** — 对端上报的主公网地址
4. **raddr** — 客户端观测到的对端源地址

客户端按 **LAN → assisted → raddr → pubSocket** 的顺序扫描，命中即停。

**LAN 命中判定**：`hasTrafficFromTargetLAN(peerID, since)` 检查 `lastLANRecvAt`。
**公网命中判定**：`hasTrafficFromTargetPublic(peerID, since)` 检查 `lastPublicRecvAt`。

两者分开，`recordP2PSuccess` 只在公网命中时更新 `UDPAddr`，LAN 命中直接 `MarkLAN`。

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
| 打洞协调复杂度 | O(N²)，`runCoordination` 500ms 节流 |

### 免费版配额

- **每天 10 万次请求**（Worker）
- **DO Storage 每天 1000 次写操作**（`reportToRegistry` 500ms 去抖）

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

### Q: 两端状态不一致（A=lan，B=p2p）？

**正常现象**——A 和 B 各自的 `relayMgr.states` 独立管理，可能不同步：

- A 从 LAN 收到 B 的数据帧 → A 标 `ConnLAN`
- B 从公网收到 A 的数据帧 → B 标 `ConnP2P`

这是**设计如此**——每端只关心自己到对端的路径。

### Q: 两端状态不一致（A=p2p，B=TURN）？

**单向打洞成功**——A 的 probe 命中 B，但 B 回发给 A 的 probe 丢包了。

**修复**：
- 客户端用 `hasTrafficFromTarget` 替代 `hasTrafficAny`
- 服务端用 `anySucceeded` 替代 `bothSucceeded`
- **TURN 帧降级**：B 通过 TURN 发给 A 的数据帧，A 收到后 `ForceFallback("peer-via-turn")` → A 也降级

### Q: 同 STUN 出口 IP 时疯狂打洞？

**`coordinator.js` 太旧**，还在无脑派发打洞指令。

**最新版逻辑**：

1. **首次遇到** → 允许一次 hairpin 尝试
2. **已失败过** → 下发 `force_fallback` 强制降级
3. **已是 LAN** → 跳过（`connections` 里 `lan` 值）

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
if st == ConnLAN || st == ConnP2P {
    e.reportP2PStatus(instr.TargetMac, 3)
    return
}
```

**验证**：客户端日志 `[NAT-HOLE] 跳过指令 target=xxx（已 ConnP2P），上报 p2p_status=3` **只出现一次**。

### Q: TURN 服务器额度用尽？

**客户端会自动降级到 WS 中继**，不影响使用。

**建议**：升级 Cloudflare TURN 套餐，或加自建 coturn（配置 `TURN_SERVERS`）。

### Q: Worker 请求额度用尽？

**打洞失败时每条数据都走 Worker 中继**，消耗很快。

**修复**：
1. 优先让 LAN 打通（同 WiFi 场景）
2. 优先让 P2P 打通（hairpin）
3. 配置 TURN，让流量走 TURN 而不是 Worker

### Q: `natType` 显示不一致（一端 HardNAT、一端 EasyNAT）？

**客户端版本不一致**——一端是旧版（单样本判 EasyNAT），另一端是新版（单样本判 unknown）。

**修复**：两端升级到同一版本客户端。

### Q: 同一对设备一会走 LAN 一会走 TURN？

**网络切换**。客户端 WiFi1 → WiFi2，`ConnLAN → ConnUnknown`，重新打洞。

**修复**：客户端已通过 `onLinkPropertiesChanged` 毫秒级感知，T+5~10s 收敛。

**服务端对应处理**：`network_changed` 广播 + `clearPairStateFor`。

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

### Q: 房间完全空后多久从面板消失？

**5 分钟内**。`Room.alarm` 触发时 `peers.size === 0` 主动清 registry（`_clear-one`）。

旧版要等 registry 1 小时无活动才清理，中间面板显示"0 个设备"。

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
[Room] p2p_metadata from xxx: natType=... pub=... lan=... subnets=... features=["n2na","n2nw"]
[NAT] xxx 同 STUN 出口 IP (120.239.134.13)，允许一次 hairpin 尝试
[NAT] xxx 同 STUN 出口 IP 已尝试失败，标记强制降级
[Room] xxx 网络变化 (gateway:192.168.2.1)，清空打洞状态并广播
[Room] → xxx 下发 nat_hole_instruction role=1 target=... lan=1
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
  "actualSource": "none",
  "actualSourceAt": 0,
  "servers": [],
  "priority": []
}
```

**配了自定义 TURN**：

```json
{
  "enabled": true,
  "source": "custom",
  "actualSource": "custom",
  "actualSourceAt": 1729651200000,
  "servers": [{"url": "turn:111.171.194.230:3478"}],
  "priority": ["custom"]
}
```

### Q: `curl /api/turn-credentials` 返回 `"source": "custom"`，但我配了 Cloudflare TURN？

**症状**：明明设置了 `TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN`，但 `source` 一直是 `custom`。

**原因**：

1. **旧版 bug**：`generateCloudflareTURN` 里 `for (const ice of data.iceServers || [])` 对对象会抛 `TypeError`
2. **Cloudflare TURN API 慢**：请求 hold 30 秒后超时返回空
3. **API Token 过期**

**修复**：

1. 用最新版 `index.ts`（已修 `iceServers` 解析 + 5 秒超时）
2. 重新验证：

```bash
curl -s "https://xxx.workers.dev/api/turn-credentials" | jq '.source'
# 应该输出 "cloudflare"
```

### Q: 管理面板 TURN 显示黄色 `(实际: custom)`？

**配置层面是 Cloudflare，但最近一次实际成功用的是 custom**。

**原因**：Cloudflare TURN API 调用失败（超时/HTTP 错误/空响应）→ fallback 到 custom。

**修复**：

1. 检查 `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` 是否正确
2. 查看 Worker 日志 `[TURN] Cloudflare API failed:` 的具体错误
3. 如果 API Token 过期，重新创建 TURN Key

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

### Q: 管理面板为什么有的设备显示 `无能力上报`？

**旧客户端**（升级 features 之前的版本）不上报 `features` 字段。

- **不影响功能**：服务端自动降级到文本 `app_stream_data`，连接正常
- **升级后消失**：客户端升级到支持 `features` 的版本后，会正常显示 `n2na` / `n2nw` chips

### Q: 混合房间（新老客户端共存）会丢数据吗？

**不会**。

服务端按目标端协商：

- 发送方新、接收方新 → N2NA 二进制
- 发送方新、接收方旧（无 n2na） → 自动解码转文本 `app_stream_data`
- 发送方新、接收方旧（无 n2nw） → **丢弃 + 警告**（旧客户端只懂裸 IPv4）
- 发送方旧、接收方新 → 文本转发（新客户端兼容）
- 双方都旧 → 文本

**旧客户端完全无感知**，新客户端自动获得二进制优化。

### Q: WiFi1 → WiFi2 切换后 30-60 秒才恢复？

**客户端是旧版**（没有 `onLinkPropertiesChanged` 网关检测）。

**原因**：`onAvailable` 只在网络类型变化时触发（WiFi ↔ Cellular），WiFi 间切换 `type` 都是 `"wifi"` → 不触发 → 状态机停留在 `ConnLAN` → 持续丢包。

**修复**：升级客户端到 v2.0+（含 `onLinkPropertiesChanged` 网关检测 + `OnNetworkChanged` 状态重置）。

**验证**：客户端日志 `[Network] 网关变化: 192.168.1.1 → 192.168.2.1，通知 Go 层`。

### Q: 双 WAN / 多 AP 上行场景，同 LAN 却走 TURN/WS？

**服务端 `shouldShareLan` 只看公网 IP**（旧版）。

**原因**：A 走 WAN1（1.1.1.1），B 走 WAN2（2.2.2.2）→ 公网 IP 不同 → `shouldShareLan` 返回 false → `lanEndpoints` 被过滤 → 客户端匹配不上 LAN 包 → 打洞失败。

**修复**：

1. 服务端 `shouldShareLan` 优先看 `lanSubnets` 重叠（v2.0+）
2. 客户端 `ensureTargetPeer` 从 `nat_hole_instruction` 补充 `LanEndpoints`

**验证**：服务端日志 `[NAT] pair-xxx 生成指令... lan=1/1`，面板 `lan-XX`。

### Q: 快速点 停止→启动，SOCKS5 端口冲突？

**症状**：用户看到"启动成功"，但 `curl --socks5 127.0.0.1:1080` 连不上。

**原因**：`N2nController.stop()` 是异步的，`Client.Stop` → `Client.Start` → `NewSocks5Server` → `net.Listen` → `EADDRINUSE`（旧的 SOCKS5 没关）。旧版 `Serve()` 里静默 return，上层不知道端口冲突。

**修复**：升级客户端到 v2.0+（`Socks5Server.Listen()` 失败返回 error，UI 显示"启动失败: SOCKS5 监听 ... 失败"）。

**验证**：通知栏显示 `启动失败: SOCKS5 监听 127.0.0.1:1080 失败: address already in use`，3 秒后自动停止。

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
| 上报 `lanSubnets` | ✅ | ✅ | ✅ |
| 上报 `assistedEndpoints` | ✅ | ✅ | ✅ |
| 上报 `features` | ✅ `["n2na","n2nw"]` | ✅ `["n2na","n2nw"]` | ✅ `["n2na","n2nw"]` |

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

当打洞和 TURN 都失败时，三端降级到 **WS 中继**。此路径使用三套协议：

1. **`SendBinary` N2NW** — 原始 IPv4 包（用于 TUN ↔ TUN / TUN ↔ packet_forwarder 的纯数据面转发）
2. **`SendBinary` N2NA** — app_stream 二进制（`features` 协商通过时）
3. **`app_stream_*` 文本** — 应用层 TCP 隧道（`features` 协商降级时）

**三端都实现了这三套协议**，所以 WS 中继路径也完全互通。

**ICMP 特殊处理**：由于单向 P2P 常见（CGNAT 打洞后 A→B 通、B→A 断），Termux 端将 **ICMP 响应强制走 WS 中继**（牺牲延迟换可靠），确保 ping 稳定。

---

## 🔄 版本历史

### v2.0（当前）—— LAN / 网络切换 / 状态机统一

**新增功能**：
- `ConnLAN` 独立状态（LAN 和公网 P2P 分开）
- `lanSubnets` 上报 + `cidrOverlaps` 重叠判定（双 WAN / 多 AP 上行走 LAN）
- `onLinkPropertiesChanged` 网关检测（WiFi1 → WiFi2 也触发 `OnNetworkChanged`）
- `OnNetworkChanged` 状态重置（清 P2P/LAN/UDPAddr，保留 TURN/WS）
- `network_changed` 广播 + `peer_network_changed` 处理
- `actualSource` 追踪（TURN 配置 vs 实际不一致时黄色提示）
- `alarm` 房间空时主动清 registry

**修复**：
- `pairPairs` 替代 `paired`（N≥3 房间所有 pair 都评估）
- `isRealData` 加 `viaTURN` 分支（TURN 收数据误判 P2P → 持续丢包）
- TURN 帧 `peer-via-turn` / WS 帧 `peer-via-ws` 降级（单向 P2P 自动降级）
- `MarkFallback` 删 10s 保护（`ConnUnknown` 卡住）
- `sendP2PIdleKeepalive` 30s 只对 `ConnP2P` 生效（`ConnP2PAvailable` 交给 60s 超时）
- `SendToPeer` 的 `ConnLAN` 失败降级到 `ConnP2PAvailable`（不是 `ConnP2P`）
- `findPeerIDByAddr` 唯一命中（多 peer 同 CGNAT 串包）
- `registeredAt` 兜底（初始 LAN peer 永不切公网）
- `ensureTargetPeer` 不覆盖实时 `UDPAddr` + 补充 `LanEndpoints`
- 重连重置 `features` / `connections` / `lanEndpoints`（旧客户端能力误判）
- `p2p_metadata` 双读 `publicEndpoint` / `pubSocket`（旧协议兼容）
- N2NW 目标端 `n2nw` 检查（旧客户端静默丢包）
- 裸 IPv4 源 IP 校验（防 VIP 欺骗）
- `app_stream_data` `to` 必填 + 64KB 限制（防广播 / 大包）
- TURN API 5s 超时 + TTL clamp（Worker hold / 恶意请求）
- `reportToRegistry` 500ms 去抖（DO Storage 配额）
- `runCoordination` 500ms 节流（O(N²) CPU）
- `_clear` 清 `pendingSaveTimer`（空状态写回）
- `registry._clear-all` 只删 `rooms` key（不用 `deleteAll`）
- `force_fallback` 在 LAN/P2P 时上报 `p2p_status=3`（服务端状态同步）
- `peerExists` 大小写不敏感
- `allocID` 加时间戳（客户端崩溃重启串话）
- `recordP2PSuccess` 补 `registeredAt` + LAN 命中 MarkLAN
- `MarkP2PAvailable` 上报 `status=2`（服务端持续重发指令）
- SOCKS5 `Listen()` 拆出（端口冲突不静默失败）
- `onLinkPropertiesChanged` 跳过 `TRANSPORT_VPN`（避免循环）
- Kotlin `refreshPeers` 比较 code 序列（顺序变化时全量重建）
- Kotlin `break continue in inline lambdas` 编译错误

### v1.0 —— 基础四级降级

- 四级降级（LAN → P2P → TURN → WS）
- FRP 行为阶梯
- 协议能力协商（`features`）
- 双面板
- TURN 凭证分发（Cloudflare + 自定义）

---

## 📄 License

MIT

## 🔗 相关项目

- [n2n-go-client](https://github.com/goyo123321/n2n-go-client) — 跨平台客户端（桌面 / 路由器 / 服务器）
- [n2n-termux](https://github.com/goyo123321/n2n-termux) — Android Termux SOCKS5 客户端（双向互通）
- [n2n-android](https://github.com/goyo123321/n2n-android) — Android APK 客户端（VpnService）
- [pion/stun](https://github.com/pion/stun) — STUN 协议
- [gorilla/websocket](https://github.com/gorilla/websocket) — WebSocket
- [gomobile](https://pkg.go.dev/golang.org/x/mobile) — Go/Kotlin 桥接
