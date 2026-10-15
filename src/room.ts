import { DurableObject } from "cloudflare:workers";
import { NatHoleCoordinator } from "./nathole/coordinator.js";

type ConnType = "p2p" | "p2p-avail" | "turn" | "relay" | "unknown";

interface PeerRecord {
  clientId: string;
  mac: string;
  name: string;
  virtualIp: string;
  online: boolean;
  connectedAt: number;
  registeredAt: number;
  lastSeen: number;
  disconnectedAt?: number;
  connections: Map<string, ConnType>;
  pubSocket: string;
  p2pEndpoint: string;
  publicEndpoint: string;
  natType: string;
  portsDifference: number;
  regularPortsChange: boolean;
  behavior: string;
  assistedSockets: string[];
  lanEndpoints: string[];
  observedRaddr: string;
  turnRelayAddr: string;
  relayBytesIn: number;
  relayBytesOut: number;
  relayPacketsIn: number;
  relayPacketsOut: number;
  _publicIp?: string;
  multiExit?: boolean;
}

const STAGGER_FALLBACK_SAVE_MS = 300 * 1000;
const REGISTRY_REFRESH_MS = 5 * 60 * 1000;
const PEERS_STORAGE_KEY = "peers";
const COMMUNITY_STORAGE_KEY = "community";
const OFFLINE_TTL_MS = 30 * 60 * 1000;
const SAVE_THROTTLE_MS = 3 * 1000;
const SERVER_PING_INTERVAL_MS = 30 * 1000;
const PEER_STALE_MS = 90 * 1000;

const DEFAULT_VIRTUAL_NETWORK = "10.64.0.0/24";

interface ParsedCIDR {
  base: number;
  prefix: number;
  hostMax: number;
  cidr: string;
}

function parseCIDR(cidr: string): ParsedCIDR | null {
  if (!cidr) return null;
  const parts = cidr.trim().split("/");
  if (parts.length !== 2) return null;

  const ipOctets = parts[0].split(".").map((s) => parseInt(s, 10));
  if (ipOctets.length !== 4) return null;
  if (ipOctets.some((n) => isNaN(n) || n < 0 || n > 255)) return null;

  const prefix = parseInt(parts[1], 10);
  if (isNaN(prefix) || prefix < 16 || prefix > 30) return null;

  const rawBase =
    ((ipOctets[0] << 24) | (ipOctets[1] << 16) | (ipOctets[2] << 8) | ipOctets[3]) >>> 0;

  const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  const alignedBase = (rawBase & mask) >>> 0;

  const hostBits = 32 - prefix;
  const hostMax = Math.pow(2, hostBits) - 2;

  return {
    base: alignedBase,
    prefix,
    hostMax,
    cidr: `${intToIP(alignedBase)}/${prefix}`,
  };
}

function intToIP(n: number): string {
  n = n >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function idxToCode(i: number): string {
  if (i < 26) return String.fromCharCode(65 + i);
  const first = Math.floor(i / 26) - 1;
  const second = i % 26;
  return String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
}

function onlineCount(peers: Map<string, PeerRecord>): number {
  let n = 0;
  for (const p of peers.values()) if (p.online) n++;
  return n;
}

export class Room extends DurableObject {
  private sessions: Map<string, WebSocket> = new Map();
  private peers: Map<string, PeerRecord> = new Map();
  private ipToClient: Map<string, string> = new Map();
  private ipCounter = 2;
  private community = "";

  private virtualBase: number = 0;
  private virtualPrefix: number = 24;
  private virtualHostMax: number = 253;
  private virtualCidr: string = DEFAULT_VIRTUAL_NETWORK;

  private lastReport = 0;
  private lastRegistryRefresh = 0;
  private coordinator: NatHoleCoordinator;
  private saveAlarmScheduled = false;
  private loadedFromStorage = false;
  private lastSaveAt = 0;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private serverPingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.coordinator = new NatHoleCoordinator(env || {});

    const rawCidr =
      env && typeof env.VIRTUAL_NETWORK === "string" && env.VIRTUAL_NETWORK.trim()
        ? env.VIRTUAL_NETWORK.trim()
        : DEFAULT_VIRTUAL_NETWORK;

    const parsed = parseCIDR(rawCidr) || parseCIDR(DEFAULT_VIRTUAL_NETWORK)!;
    this.virtualBase = parsed.base;
    this.virtualPrefix = parsed.prefix;
    this.virtualHostMax = parsed.hostMax;
    this.virtualCidr = parsed.cidr;

    // ★ /30 从 offset 1 开始；其他从 2 开始（跳过网关）
    this.ipCounter = this.minIpOffset();

    console.log(
      `[Room] 虚拟网段: ${this.virtualCidr} ` +
      `(prefix=/${this.virtualPrefix}, 最大主机 offset=${this.virtualHostMax}, ` +
      `起始 offset=${this.ipCounter})`
    );
  }

  // ★ /30 只有 2 个可用主机，从 offset 1 开始；其他网段跳过 offset 1（网关）
  private minIpOffset(): number {
    return this.virtualPrefix >= 30 ? 1 : 2;
  }

  // ============ 网络地址工具 ============

  private extractIp(endpoint: string): string {
    if (!endpoint) return "";
    const i = endpoint.lastIndexOf(":");
    if (i < 0) return endpoint;
    return endpoint.slice(0, i);
  }

  private extractPort(endpoint: string): number {
    if (!endpoint) return 0;
    const i = endpoint.lastIndexOf(":");
    if (i < 0) return 0;
    return parseInt(endpoint.slice(i + 1), 10) || 0;
  }

  private peerPublicAddr(p: PeerRecord): { ip: string; port: number } {
    if (p.publicEndpoint) {
      const ip = this.extractIp(p.publicEndpoint);
      const port = this.extractPort(p.publicEndpoint);
      if (ip && port > 0) return { ip, port };
    }
    if (p.p2pEndpoint) {
      const ip = this.extractIp(p.p2pEndpoint);
      const port = this.extractPort(p.p2pEndpoint);
      if (ip && port > 0) return { ip, port };
    }
    return { ip: "", port: 0 };
  }

  private isInVirtualNetwork(ip: string): boolean {
    if (!ip) return false;
    const octets = ip.split(".").map((s) => parseInt(s, 10));
    if (octets.length !== 4 || octets.some((n) => isNaN(n))) return false;
    const ipInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const mask = ((0xFFFFFFFF << (32 - this.virtualPrefix)) >>> 0);
    return ((ipInt & mask) >>> 0) === this.virtualBase;
  }

  // ============ server-ping + stale 检测 ============

  private startServerPing(): void {
    if (this.serverPingTimer !== null) return;

    this.serverPingTimer = setInterval(() => {
      if (this.sessions.size === 0 && this.peers.size === 0) return;

      if (this.sessions.size > 0) {
        const data = JSON.stringify({ type: "server_ping", ts: Date.now() });
        for (const [id, ws] of this.sessions) {
          try {
            ws.send(data);
          } catch (e) {
            console.log(`[Room] server_ping 发送失败 ${id}，清理 session`);
            this.sessions.delete(id);
          }
        }
      }

      this.detectStalePeers();
    }, SERVER_PING_INTERVAL_MS);
  }

  private detectStalePeers(): void {
    const now = Date.now();

    for (const [id, p] of this.peers) {
      if (!p.online) continue;

      const ws = this.sessions.get(id);
      if (!ws) {
        p.online = false;
        p.disconnectedAt = now;
        p.connections = new Map();
        p.pubSocket = "";
        p.p2pEndpoint = "";
        p.publicEndpoint = "";
        if (p.virtualIp) this.ipToClient.delete(p.virtualIp);
        this.coordinator.clearPairStateFor(id);
        this.broadcast(id, { type: "left", from: id });
        console.log(`[Room] ${id} session 丢失（无 ws），标记离线并广播 left`);
        continue;
      }

      const idleMs = now - (p.lastSeen || 0);
      if (idleMs > PEER_STALE_MS) {
        console.log(
          `[Room] ${id} 心跳超时 ${Math.round(idleMs / 1000)}s（阈值 ${PEER_STALE_MS / 1000}s），` +
          `主动关闭 ws 并广播 left`
        );
        p.online = false;
        p.disconnectedAt = now;
        p.connections = new Map();
        p.pubSocket = "";
        p.p2pEndpoint = "";
        p.publicEndpoint = "";
        if (p.virtualIp) this.ipToClient.delete(p.virtualIp);
        this.coordinator.clearPairStateFor(id);

        try {
          ws.close(1000, "Stale: no heartbeat");
        } catch (e) {}

        this.sessions.delete(id);

        this.broadcast(id, { type: "left", from: id });
      }
    }
  }

  private stopServerPing(): void {
    if (this.serverPingTimer !== null) {
      clearInterval(this.serverPingTimer);
      this.serverPingTimer = null;
    }
  }

  // ============ 从 Storage 恢复 ============

  private async ensureLoaded(): Promise<void> {
    if (this.loadedFromStorage) return;
    this.loadedFromStorage = true;

    try {
      const storedCommunity = await this.ctx.storage.get<string>(COMMUNITY_STORAGE_KEY);
      if (storedCommunity && !this.community) this.community = storedCommunity;

      const storedPeers = await this.ctx.storage.get<Record<string, any>>(PEERS_STORAGE_KEY);
      if (storedPeers) {
        const now = Date.now();
        let restored = 0, removed = 0, droppedByCidr = 0;

        for (const [id, p] of Object.entries(storedPeers)) {
          const offlineSince = p.disconnectedAt || p.lastSeen || 0;
          if (!p.online && now - offlineSince > OFFLINE_TTL_MS) { removed++; continue; }
          if (p.online && now - (p.lastSeen || 0) > OFFLINE_TTL_MS) { removed++; continue; }

          this.peers.set(id, {
            clientId: p.clientId || id,
            mac: p.mac || id,
            name: p.name || "",
            virtualIp: p.virtualIp,
            online: !!p.online,
            connectedAt: p.connectedAt || now,
            registeredAt: p.registeredAt || now,
            lastSeen: p.lastSeen || now,
            disconnectedAt: p.disconnectedAt,
            connections: new Map(Object.entries(p.connections || {})) as Map<string, ConnType>,
            pubSocket: p.pubSocket || "",
            p2pEndpoint: p.p2pEndpoint || "",
            publicEndpoint: p.publicEndpoint || "",
            natType: p.natType || "unknown",
            portsDifference: p.portsDifference || 0,
            regularPortsChange: !!p.regularPortsChange,
            behavior: p.behavior || "",
            assistedSockets: Array.isArray(p.assistedSockets) ? p.assistedSockets : [],
            lanEndpoints: Array.isArray(p.lanEndpoints) ? p.lanEndpoints : [],
            observedRaddr: p.observedRaddr || "",
            turnRelayAddr: p.turnRelayAddr || "",
            relayBytesIn: p.relayBytesIn || 0,
            relayBytesOut: p.relayBytesOut || 0,
            relayPacketsIn: p.relayPacketsIn || 0,
            relayPacketsOut: p.relayPacketsOut || 0,
            _publicIp: p._publicIp || "",
            multiExit: !!p.multiExit,
          });

          if (p.virtualIp && p.online && this.isInVirtualNetwork(p.virtualIp)) {
            this.ipToClient.set(p.virtualIp, id);

            const octets = String(p.virtualIp).split(".").map((s) => parseInt(s, 10));
            if (octets.length === 4 && !octets.some((n) => isNaN(n))) {
              const ipInt =
                ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
              const offset = (ipInt - this.virtualBase) >>> 0;
              if (offset >= this.ipCounter && offset <= this.virtualHostMax) {
                this.ipCounter = offset + 1;
              }
            }
          } else if (p.virtualIp && p.online) {
            droppedByCidr++;
          }
          restored++;
        }
        console.log(
          `[Room] 恢复 ${restored} 个 peer（删 ${removed} 个 stale，` +
          `${droppedByCidr} 个 VIP 不在 ${this.virtualCidr} 已跳过映射）`
        );
      }
    } catch (e) {
      console.error("[Room] ensureLoaded failed:", e);
    }
  }

  // ============ 状态持久化 ============

  private async saveStateNow(): Promise<void> {
    try {
      const peersData: Record<string, any> = {};
      for (const [id, p] of this.peers) {
        peersData[id] = {
          clientId: p.clientId, mac: p.mac, name: p.name, virtualIp: p.virtualIp,
          online: p.online, connectedAt: p.connectedAt, registeredAt: p.registeredAt,
          lastSeen: p.lastSeen, disconnectedAt: p.disconnectedAt,
          connections: Object.fromEntries(p.connections),
          pubSocket: p.pubSocket, p2pEndpoint: p.p2pEndpoint, publicEndpoint: p.publicEndpoint,
          natType: p.natType, portsDifference: p.portsDifference,
          regularPortsChange: p.regularPortsChange, behavior: p.behavior,
          assistedSockets: p.assistedSockets, observedRaddr: p.observedRaddr,
          lanEndpoints: p.lanEndpoints || [],
          turnRelayAddr: p.turnRelayAddr, relayBytesIn: p.relayBytesIn,
          relayBytesOut: p.relayBytesOut, relayPacketsIn: p.relayPacketsIn,
          relayPacketsOut: p.relayPacketsOut, _publicIp: p._publicIp,
          multiExit: p.multiExit,
        };
      }
      await this.ctx.storage.put(PEERS_STORAGE_KEY, peersData);
      if (this.community) await this.ctx.storage.put(COMMUNITY_STORAGE_KEY, this.community);
      this.lastSaveAt = Date.now();
    } catch (e) {
      console.error("[Room] saveStateNow failed:", e);
    }
  }

  private saveStateThrottled(): void {
    const now = Date.now();
    if (now - this.lastSaveAt >= SAVE_THROTTLE_MS) {
      this.lastSaveAt = now;
      this.saveStateNow().catch(() => {});
      return;
    }
    if (this.pendingSaveTimer) return;
    const delay = SAVE_THROTTLE_MS - (now - this.lastSaveAt);
    this.pendingSaveTimer = setTimeout(() => {
      this.pendingSaveTimer = null;
      this.lastSaveAt = Date.now();
      this.saveStateNow().catch(() => {});
    }, delay);
  }

  // ============ HTTP 路由 ============

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (url.pathname === "/_clear") {
      const onlinePeers = Array.from(this.peers.values()).filter((p) => p.online);
      const force = url.searchParams.get("force") === "1";
      if (onlinePeers.length > 0 && !force) {
        return new Response(JSON.stringify({
          error: "Room has online peers",
          onlineCount: onlinePeers.length,
          onlinePeers: onlinePeers.map((p) => ({ clientId: p.clientId, name: p.name, virtualIp: p.virtualIp })),
        }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      for (const [_, ws] of this.sessions) { try { ws.close(1000, "Admin cleanup"); } catch {} }
      await new Promise((r) => setTimeout(r, 300));
      this.sessions.clear();
      this.stopServerPing();
      this.peers.clear();
      this.ipToClient.clear();
      // ★ 直接用 new 而不是 (this.coordinator as any).constructor
      this.coordinator = new NatHoleCoordinator(this.env || {});
      try { await this.ctx.storage.deleteAll(); } catch (e) {}
      this.ipCounter = this.minIpOffset();
      this.lastSaveAt = 0;
      return new Response(JSON.stringify({ ok: true, room: this.community }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/_kick" && request.method === "POST") {
      const cid = url.searchParams.get("cid");
      if (!cid) return new Response(JSON.stringify({ error: "Missing cid" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const ws = this.sessions.get(cid);
      const peer = this.peers.get(cid);
      if (!ws && !peer) return new Response(JSON.stringify({ error: "Peer not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      if (ws) { try { ws.close(1000, "Admin kicked"); } catch {} }
      if (peer) {
        peer.online = false;
        peer.disconnectedAt = Date.now();
        peer.connections = new Map();
        peer.pubSocket = "";
        peer.p2pEndpoint = "";
        peer.publicEndpoint = "";
      }
      this.sessions.delete(cid);
      if (peer?.virtualIp) this.ipToClient.delete(peer.virtualIp);
      this.coordinator.clearPairStateFor(cid);
      this.broadcast(cid, { type: "left", from: cid });
      await this.reportToRegistry(true);
      await this.saveStateNow();
      return new Response(JSON.stringify({ ok: true, kicked: cid }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/_status") {
      const publicOnly = url.searchParams.get("public") === "1";
      const communityParam = url.searchParams.get("community");
      if (communityParam && !this.community) this.community = communityParam;
      return this.getStatusResponse(publicOnly);
    }

    if (url.pathname === "/_nathole") {
      const communityParam = url.searchParams.get("community");
      if (communityParam && !this.community) this.community = communityParam;
      return this.getNatHoleStatusResponse();
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

    const clientId = url.searchParams.get("cid") || crypto.randomUUID();
    this.community = url.pathname.split("/")[2] || "default";

    const publicIp =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      "";

    this.closeDuplicate(clientId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    (this.ctx as any).acceptWebSocket(server);

    const now = Date.now();
    try { await this.ctx.storage.put(COMMUNITY_STORAGE_KEY, this.community); } catch {}

    const onlinePeersForClient = Array.from(this.peers.values())
      .filter((p) => p.online && p.clientId !== clientId)
      .map((p) => {
        const addr = this.peerPublicAddr(p);
        return {
          id: p.clientId,
          virtualIp: p.virtualIp,
          publicIp: addr.ip,
          publicPort: addr.port,
          natType: p.natType || "unknown",
          turnRelayAddr: p.turnRelayAddr || "",
          assistedEndpoints: p.assistedSockets || [],
          lanEndpoints: p.lanEndpoints || [],
        };
      });

    let peer = this.peers.get(clientId);
    if (peer) {
      this.coordinator.clearPairStateFor(clientId);
      peer.online = true;
      peer.connectedAt = now;
      peer.lastSeen = now;
      peer.disconnectedAt = undefined;
      peer._publicIp = publicIp;

      if (peer.virtualIp && !this.isInVirtualNetwork(peer.virtualIp)) {
        const oldVip = peer.virtualIp;
        this.ipToClient.delete(oldVip);
        peer.virtualIp = this.allocateIp();
        console.log(
          `[Room] ${clientId} 旧 VIP ${oldVip} 不在网段 ${this.virtualCidr}，` +
          `重新分配 ${peer.virtualIp}`
        );
      }

      const conflict = Array.from(this.peers.values()).find(
        (p) => p.clientId !== clientId && p.online && p.virtualIp === peer!.virtualIp
      );
      if (conflict) {
        const oldVip = peer.virtualIp;
        this.ipToClient.delete(oldVip);
        peer.virtualIp = this.allocateIp();
        console.log(
          `[Room] ${clientId} VIP 冲突：${oldVip} 已被 ${conflict.clientId} 占用，` +
          `重新分配 ${peer.virtualIp}`
        );
      }
    } else {
      peer = {
        clientId, mac: clientId, name: "",
        virtualIp: this.allocateIp(),
        online: true, connectedAt: now, registeredAt: now, lastSeen: now,
        connections: new Map(),
        pubSocket: "", p2pEndpoint: "", publicEndpoint: "",
        natType: "unknown", portsDifference: 0, regularPortsChange: false,
        behavior: "BehaviorPortChanged", assistedSockets: [], observedRaddr: "",
        lanEndpoints: [],
        turnRelayAddr: "", relayBytesIn: 0, relayBytesOut: 0, relayPacketsIn: 0, relayPacketsOut: 0,
        _publicIp: publicIp,
        multiExit: false,
      };
      this.peers.set(clientId, peer);
    }
    this.ipToClient.set(peer.virtualIp, clientId);
    this.sessions.set(clientId, server);

    this.startServerPing();

    await this.reportToRegistry(true);
    await this.setupSaveAlarm();
    await this.saveStateNow();

    server.send(JSON.stringify({
      type: "ready", from: clientId,
      payload: {
        id: clientId,
        virtualIp: peer.virtualIp,
        yourPublicIp: publicIp,
        virtualNetwork: this.virtualCidr,
        peers: onlinePeersForClient,
      },
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") await this.handleControl(ws, message);
    else await this.handleBinary(ws, message);
  }

  private async handleControl(ws: WebSocket, message: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }
    const from = this.findClientId(ws);
    if (!from) return;
    const peer = this.peers.get(from);
    if (peer) peer.lastSeen = Date.now();

    switch (msg.type) {
      case "server_pong":
        return;

      case "ping":
        try { ws.send(JSON.stringify({ type: "pong", from, t: msg.ts || Date.now() })); } catch {}
        return;

      case "connection_status":
        if (peer) peer.connections = new Map(Object.entries(msg.payload?.connections || {})) as Map<string, ConnType>;
        return;

      case "p2p_metadata":
        if (peer) {
          const p = msg.payload || {};
          if (typeof p.name === "string" && p.name) peer.name = p.name;
          peer.natType = p.natType || peer.natType;
          peer.portsDifference = p.portsDifference || 0;
          peer.regularPortsChange = !!p.regularPortsChange;
          peer.behavior = p.behavior || peer.behavior;

          if (Array.isArray(p.assistedEndpoints)) {
            peer.assistedSockets = p.assistedEndpoints.filter(
              (s: any) => typeof s === "string" && s
            );
          } else if (Array.isArray(p.assistedSockets)) {
            peer.assistedSockets = p.assistedSockets.filter(
              (s: any) => typeof s === "string" && s
            );
          }

          if (Array.isArray(p.lanEndpoints)) {
            peer.lanEndpoints = p.lanEndpoints.filter(
              (s: any) => typeof s === "string" && s
            );
          }

          if (typeof p.p2pEndpoint === "string" && p.p2pEndpoint) peer.p2pEndpoint = p.p2pEndpoint;

          const publicEndpoint = typeof p.publicEndpoint === "string" ? p.publicEndpoint : "";
          if (publicEndpoint && publicEndpoint !== "") {
            // ★ 已修复：只在"出口 IP 变化"时清空打洞状态，端口变化不清
            const oldPubSocket = peer.pubSocket;
            const oldIp = this.extractIp(oldPubSocket);
            const newIp = this.extractIp(publicEndpoint);
            if (oldIp && newIp && oldIp !== newIp) {
              this.coordinator.clearPairStateFor(from);
              console.log(
                `[Room] ${from} 出口 IP 变化: ${oldIp} → ${newIp}，清空打洞状态`
              );
            }
            peer.publicEndpoint = publicEndpoint;
            peer.pubSocket = publicEndpoint;
          } else {
            if (!peer.publicEndpoint) peer.pubSocket = "";
          }

          if (typeof p.multiExit === "boolean") peer.multiExit = p.multiExit;

          this.saveStateThrottled();

          const addr = this.peerPublicAddr(peer);
          console.log(
            `[Room] p2p_metadata from ${from}: natType=${peer.natType} ` +
            `pub=${addr.ip}:${addr.port} (pubSocket=${peer.pubSocket || "<empty>"}) ` +
            `lan=${(peer.lanEndpoints || []).length} multiExit=${peer.multiExit || false} assisted=${peer.assistedSockets.length}`
          );

          this.broadcast(from, {
            type: "joined", from,
            payload: {
              id: from,
              virtualIp: peer.virtualIp,
              publicIp: addr.ip,
              publicPort: addr.port,
              natType: peer.natType || "unknown",
              turnRelayAddr: peer.turnRelayAddr || "",
              assistedEndpoints: peer.assistedSockets || [],
              lanEndpoints: peer.lanEndpoints || [],
            },
          });
        }
        await this.runCoordination();
        await this.setupSaveAlarm();
        return;

      case "p2p_state_info":
        if (peer && msg.payload && Array.isArray(msg.payload.to)) {
          for (const t of msg.payload.to) {
            if (!t || !t.macAddr) continue;
            if (t.observedRaddr) {
              const target = this.peers.get(t.macAddr);
              if (target) target.observedRaddr = t.observedRaddr;
            }
            if (t.punchResult && t.punchResultPeerMac) {
              const selfStatus = typeof t.p2pStatus === "number" ? t.p2pStatus : 0;
              this.coordinator.recordPunchResult(
                from,
                t.punchResultPeerMac,
                t.punchResult,
                selfStatus
              );
            }
          }
        }
        await this.runCoordination();
        await this.setupSaveAlarm();
        return;

      case "turn_relay_info": {
        if (!peer) return;
        const relayAddr = msg.relayAddr || "";
        if (!relayAddr) return;
        peer.turnRelayAddr = relayAddr;
        this.saveStateThrottled();
        for (const [id, p] of this.peers) {
          if (id === from || !p.online) continue;
          const targetWs = this.sessions.get(id);
          if (!targetWs) continue;
          try { targetWs.send(JSON.stringify({ type: "turn_peer_info", edgeMac: from, relayAddr })); } catch {}
        }
        return;
      }

      default:
        if (msg.to) {
          const target = this.sessions.get(msg.to);
          if (target) target.send(JSON.stringify({ ...msg, from }));
        } else {
          this.broadcast(from, { ...msg, from });
        }
    }
  }

  private async handleBinary(ws: WebSocket, message: ArrayBuffer | Blob): Promise<void> {
    let buffer: ArrayBuffer;
    if (message instanceof ArrayBuffer) buffer = message;
    else buffer = await (message as Blob).arrayBuffer();

    const data = new Uint8Array(buffer);
    if (data.length < 20) return;
    if (data[0] >> 4 !== 4) return;

    const dstIP =
      `${data[16]}.${data[17]}.${data[18]}.${data[19]}`;
    if (!this.isInVirtualNetwork(dstIP)) return;

    const from = this.findClientId(ws);
    if (!from) return;
    const targetClientId = this.ipToClient.get(dstIP);
    if (!targetClientId) return;
    const targetWs = this.sessions.get(targetClientId);
    if (!targetWs) return;

    try {
      targetWs.send(buffer);
      const fromPeer = this.peers.get(from);
      const toPeer = this.peers.get(targetClientId);
      if (fromPeer) { fromPeer.relayBytesOut += data.length; fromPeer.relayPacketsOut += 1; }
      if (toPeer) { toPeer.relayBytesIn += data.length; toPeer.relayPacketsIn += 1; }
    } catch {}
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const clientId = this.findClientId(ws);
    if (clientId) {
      const peer = this.peers.get(clientId);
      const alreadyHandled = peer && !peer.online && !this.sessions.has(clientId);
      if (peer && !alreadyHandled) {
        peer.online = false;
        peer.disconnectedAt = Date.now();
        peer.connections = new Map();
        peer.pubSocket = "";
        peer.p2pEndpoint = "";
        peer.publicEndpoint = "";
      }
      this.sessions.delete(clientId);
      if (peer?.virtualIp) this.ipToClient.delete(peer.virtualIp);
      if (!alreadyHandled) {
        this.coordinator.clearPairStateFor(clientId);
        this.broadcast(clientId, { type: "left", from: clientId });
      }
      await this.reportToRegistry(true);
      await this.saveStateNow();

      if (this.sessions.size === 0) {
        this.stopServerPing();
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ============ 打洞协调 ============

  private async runCoordination(): Promise<void> {
    const onlinePeers = Array.from(this.peers.values()).filter((p) => p.online);
    if (onlinePeers.length < 2) return;

    const community = { getOnlinePeers: () => onlinePeers };
    const { instructions, forceFallbacks } = this.coordinator.coordinate(community);

    if (forceFallbacks && forceFallbacks.size > 0) {
      for (const [mac, peers] of forceFallbacks) {
        const targetWs = this.sessions.get(mac);
        if (!targetWs) continue;
        const peerList = Array.from(peers);
        try {
          targetWs.send(JSON.stringify({
            type: "force_fallback",
            from: "server",
            payload: { peers: peerList, reason: "server-forced" },
          }));
          console.log(`[Room] → ${mac} 下发 force_fallback (${peerList.length} peers)`);
        } catch (e) {
          console.error(`[Room] force_fallback 发送失败:`, e);
        }
      }
    }

    if (instructions.size === 0) return;

    const receivers: Array<[string, any]> = [];
    const senders: Array<[string, any]> = [];
    for (const [mac, instr] of instructions) {
      if (instr.role === 0) senders.push([mac, instr]);
      else receivers.push([mac, instr]);
    }

    const sendOne = (mac: string, instr: any) => {
      const targetWs = this.sessions.get(mac);
      if (!targetWs) return;
      try {
        targetWs.send(JSON.stringify({
          type: "nat_hole_instruction",
          from: "server",
          payload: instr,
        }));
        console.log(`[Room] → ${mac} 下发 nat_hole_instruction role=${instr.role} target=${instr.targetPubSocket} lan=${(instr.targetLanEndpoints || []).length}`);
      } catch (e) {
        console.error(`[Room] 发送给 ${mac} 失败:`, e);
      }
    };

    for (const [mac, instr] of receivers) sendOne(mac, instr);

    if (senders.length > 0) {
      let delayMs = (this.coordinator as any).getSenderDelayMs
        ? (this.coordinator as any).getSenderDelayMs()
        : 1000;

      for (const [, instr] of senders) {
        if (instr.sendDelayMs && instr.sendDelayMs > 0) {
          delayMs = instr.sendDelayMs;
          break;
        }
      }

      if (delayMs <= 0) {
        for (const [mac, instr] of senders) sendOne(mac, instr);
      } else {
        await new Promise((r) => setTimeout(r, delayMs));
        for (const [mac, instr] of senders) sendOne(mac, instr);
        console.log(`[Room] sender 指令延迟 ${delayMs}ms 后下发（${senders.length} 个）`);
      }
    }
  }

  // ============ 状态查询 ============

  private getStatusResponse(publicOnly = false): Response {
    const now = Date.now();
    const sortedPeers = Array.from(this.peers.values()).sort((a, b) => a.registeredAt - b.registeredAt);
    const codeMap = new Map<string, string>();
    sortedPeers.forEach((p, idx) => codeMap.set(p.clientId, idxToCode(idx)));

    let onlineCnt = 0, offlineCnt = 0;
    for (const p of this.peers.values()) { if (p.online) onlineCnt++; else offlineCnt++; }

    const peers = sortedPeers.map((p) => {
      const code = codeMap.get(p.clientId)!;
      const connectionsByCode: Record<string, string> = {};
      for (const [cid, type] of p.connections) {
        const targetCode = codeMap.get(cid);
        if (targetCode) connectionsByCode[targetCode] = type;
      }

      let p2pCount = 0, relayCount = 0, turnCount = 0, availCount = 0;
      for (const t of p.connections.values()) {
        if (t === "p2p") p2pCount++;
        else if (t === "p2p-avail") availCount++;
        else if (t === "turn") turnCount++;
        else if (t === "relay") relayCount++;
      }
      const totalConnections = p2pCount + availCount + turnCount + relayCount;

      const relayBytesIn = p.relayBytesIn, relayBytesOut = p.relayBytesOut;

      if (publicOnly) {
        return {
          code, virtualIp: p.online ? p.virtualIp : "",
          online: p.online,
          onlineFor: now - p.connectedAt,
          offlineFor: p.online ? 0 : (p.disconnectedAt ? now - p.disconnectedAt : 0),
          idleFor: now - p.lastSeen,
          p2pCount, relayCount, turnCount, availCount,
          connectionsTotal: totalConnections,
          connections: connectionsByCode,
          natType: p.natType || "unknown",
          relayBytesIn, relayBytesOut, relayBytesTotal: relayBytesIn + relayBytesOut,
        };
      }

      return {
        code, clientId: p.clientId, name: p.name,
        virtualIp: p.online ? p.virtualIp : "",
        publicIp: p._publicIp || "",
        pubSocket: p.pubSocket, p2pEndpoint: p.p2pEndpoint, publicEndpoint: p.publicEndpoint,
        turnRelayAddr: p.turnRelayAddr, natType: p.natType,
        multiExit: !!p.multiExit,
        assistedSockets: p.assistedSockets || [],
        lanEndpoints: p.lanEndpoints || [],
        online: p.online, connectedAt: p.connectedAt, lastSeen: p.lastSeen, disconnectedAt: p.disconnectedAt,
        onlineFor: now - p.connectedAt,
        offlineFor: p.online ? 0 : (p.disconnectedAt ? now - p.disconnectedAt : 0),
        idleFor: now - p.lastSeen,
        connections: connectionsByCode,
        p2pCount, relayCount, turnCount, availCount,
        connectionsTotal: totalConnections,
        relayBytesIn, relayBytesOut,
        relayPacketsIn: p.relayPacketsIn, relayPacketsOut: p.relayPacketsOut,
      };
    });

    return new Response(JSON.stringify({
      community: this.community,
      virtualNetwork: this.virtualCidr,
      peerCount: peers.length,
      onlineCount: onlineCnt,
      offlineCount: offlineCnt,
      peers, timestamp: now, publicOnly,
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  private getNatHoleStatusResponse(): Response {
    const c = this.coordinator as any;
    const now = Date.now();
    const backoff: any[] = [];
    for (const [k, v] of c.backoff) {
      backoff.push({ pair: k, signature: v.signature, remainingMs: Math.max(0, v.nextAllowedAt - now), staggered: !!v.staggered });
    }
    const punch: any[] = [];
    for (const [k, v] of c.punchState) {
      punch.push({
        pair: k,
        aState: v.aState, bState: v.bState,
        aAttempts: v.aAttempts, bAttempts: v.bAttempts,
        aP2PStatus: v.aP2PStatus,
        bP2PStatus: v.bP2PStatus,
        everValidated: !!v.everValidated,
        behaviorIndex: v.behaviorIndex,
        ageMs: now - v.at,
      });
    }
    const inflight: any[] = [];
    for (const [k, v] of c.inFlight) {
      inflight.push({
        pair: k, rung: v.rung, signature: v.signature,
        ageMs: now - v.at,
      });
    }
    return new Response(JSON.stringify({ now, backoff, punch, inflight }, null, 2), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  private async setupSaveAlarm(): Promise<void> {
    let wakeAt = Date.now() + STAGGER_FALLBACK_SAVE_MS;
    const coordAt = this.coordinator.nextWakeDeadline();
    if (coordAt != null && coordAt < wakeAt) wakeAt = coordAt;
    await this.ctx.storage.setAlarm(wakeAt);
    this.saveAlarmScheduled = true;
  }

  async alarm(): Promise<void> {
    try {
      await this.ensureLoaded();
      const now = Date.now();
      let purged = 0;
      for (const [id, p] of this.peers) {
        if (!p.online && p.disconnectedAt && now - p.disconnectedAt > OFFLINE_TTL_MS) {
          if (p.virtualIp) this.ipToClient.delete(p.virtualIp);
          this.peers.delete(id);
          purged++;
        }
      }
      await this.runCoordination();
      await this.setupSaveAlarm();
      await this.saveStateNow();
      if (onlineCount(this.peers) > 0) {
        if (now - this.lastRegistryRefresh >= REGISTRY_REFRESH_MS) {
          this.lastRegistryRefresh = now;
          await this.reportToRegistry(true);
        }
      }
    } catch (e) {
      console.error("[Alarm] failed:", e);
      try { await this.setupSaveAlarm(); } catch {}
    }
  }

  private findClientId(ws: WebSocket): string | undefined {
    for (const [id, socket] of this.sessions) if (socket === ws) return id;
    return undefined;
  }

  private closeDuplicate(clientId: string) {
    const existing = this.sessions.get(clientId);
    if (existing) {
      try { existing.close(1000, "Duplicate connection replaced"); } catch {}
      this.sessions.delete(clientId);
    }
  }

  private broadcast(senderId: string, msg: any) {
    const data = JSON.stringify(msg);
    for (const [id, socket] of this.sessions) {
      if (id !== senderId) {
        try { socket.send(data); } catch {}
      }
    }
  }

  // ★ 已修复：支持 /30 网段（从 offset 1 开始）
  private allocateIp(): string {
    const used = new Set<string>();
    for (const p of this.peers.values()) {
      if (p.virtualIp) used.add(p.virtualIp);
    }
    for (const ip of this.ipToClient.keys()) {
      used.add(ip);
    }

    const minOffset = this.minIpOffset();
    const maxOffset = this.virtualHostMax;
    const poolSize = Math.max(1, maxOffset - minOffset + 1);

    for (let i = 0; i < poolSize; i++) {
      if (this.ipCounter < minOffset || this.ipCounter > maxOffset) {
        this.ipCounter = minOffset;
      }
      const candidate = intToIP(this.virtualBase + this.ipCounter);
      this.ipCounter++;
      if (!used.has(candidate)) return candidate;
    }

    throw new Error(
      `IP pool exhausted (CIDR=${this.virtualCidr}, max offset=${this.virtualHostMax})`
    );
  }

  private async reportToRegistry(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastReport < 5000) return;
    this.lastReport = now;
    try {
      const env = this.env as any;
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      await reg.fetch(new Request("http://internal/register", {
        method: "POST",
        body: JSON.stringify({
          roomName: this.community,
          peerCount: this.peers.size,
          onlineCount: onlineCount(this.peers),
          offlineCount: this.peers.size - onlineCount(this.peers),
        }),
      }));
    } catch {}
  }
}
