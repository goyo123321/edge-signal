import { DurableObject } from "cloudflare:workers";
import { NatHoleCoordinator } from "./nathole/coordinator.mjs";

type ConnType = "p2p" | "turn" | "relay" | "unknown";

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
  sharePort: number;
  natType: string;
  portsDifference: number;
  regularPortsChange: boolean;
  behavior: string;
  assistedSockets: string[];
  observedRaddr: string;
  turnRelayAddr: string;
  relayBytesIn: number;
  relayBytesOut: number;
  relayPacketsIn: number;
  relayPacketsOut: number;
  _publicIp?: string;
  // ★ 同 WiFi 检测字段
  lanIp?: string;
  gatewayIp?: string;
  udpPort?: number;
}

const STAGGER_FALLBACK_SAVE_MS = 300 * 1000;
const REGISTRY_REFRESH_MS = 5 * 60 * 1000;
const PEERS_STORAGE_KEY = "peers";
const COMMUNITY_STORAGE_KEY = "community";
const OFFLINE_TTL_MS = 30 * 60 * 1000;
const SAVE_THROTTLE_MS = 3 * 1000;

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
  private lastReport = 0;
  private lastRegistryRefresh = 0;
  private shareAnnounces: Map<string, any> = new Map();
  private coordinator: NatHoleCoordinator;
  private pendingStaggerAt: number | null = null;
  private saveAlarmScheduled = false;
  private loadedFromStorage = false;
  private lastSaveAt = 0;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  // ★ 同 WiFi 已通知集合
  private sameWiFiNotified: Set<string> = new Set();

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.coordinator = new NatHoleCoordinator(env || {});
  }

  private extractIp(endpoint: string): string {
    if (!endpoint) return "";
    const i = endpoint.lastIndexOf(":");
    if (i < 0) return endpoint;
    return endpoint.slice(0, i);
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
    return { ip: p._publicIp || "", port: 0 };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadedFromStorage) return;
    this.loadedFromStorage = true;

    try {
      const storedCommunity = await this.ctx.storage.get<string>(COMMUNITY_STORAGE_KEY);
      if (storedCommunity && !this.community) this.community = storedCommunity;

      const storedPeers = await this.ctx.storage.get<Record<string, any>>(PEERS_STORAGE_KEY);
      if (storedPeers) {
        const now = Date.now();
        let restored = 0, removed = 0;

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
            connections: new Map(Object.entries(p.connections || {})),
            pubSocket: p.pubSocket || "",
            p2pEndpoint: p.p2pEndpoint || "",
            publicEndpoint: p.publicEndpoint || "",
            sharePort: p.sharePort || 0,
            natType: p.natType || "unknown",
            portsDifference: p.portsDifference || 0,
            regularPortsChange: !!p.regularPortsChange,
            behavior: p.behavior || "",
            assistedSockets: Array.isArray(p.assistedSockets) ? p.assistedSockets : [],
            observedRaddr: p.observedRaddr || "",
            turnRelayAddr: p.turnRelayAddr || "",
            relayBytesIn: p.relayBytesIn || 0,
            relayBytesOut: p.relayBytesOut || 0,
            relayPacketsIn: p.relayPacketsIn || 0,
            relayPacketsOut: p.relayPacketsOut || 0,
            _publicIp: p._publicIp || "",
            lanIp: p.lanIp || "",
            gatewayIp: p.gatewayIp || "",
            udpPort: p.udpPort || 0,
          });

          if (p.virtualIp && p.online) {
            this.ipToClient.set(p.virtualIp, id);
            const parts = String(p.virtualIp).split(".");
            if (parts.length === 4) {
              const last = parseInt(parts[3], 10);
              if (!isNaN(last) && last >= this.ipCounter) this.ipCounter = last + 1;
            }
          }
          restored++;
        }
        console.log(`[Room] 恢复 ${restored} 个 peer（删 ${removed} 个 stale）`);
      }
    } catch (e) {
      console.error("[Room] ensureLoaded failed:", e);
    }
  }

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
          sharePort: p.sharePort, natType: p.natType, portsDifference: p.portsDifference,
          regularPortsChange: p.regularPortsChange, behavior: p.behavior,
          assistedSockets: p.assistedSockets, observedRaddr: p.observedRaddr,
          turnRelayAddr: p.turnRelayAddr, relayBytesIn: p.relayBytesIn,
          relayBytesOut: p.relayBytesOut, relayPacketsIn: p.relayPacketsIn,
          relayPacketsOut: p.relayPacketsOut, _publicIp: p._publicIp,
          lanIp: p.lanIp, gatewayIp: p.gatewayIp, udpPort: p.udpPort,
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
      this.peers.clear();
      this.ipToClient.clear();
      this.shareAnnounces.clear();
      this.sameWiFiNotified.clear();
      try {
        this.coordinator = new (this.coordinator as any).constructor(this.env || {});
      } catch (e) {}
      try { await this.ctx.storage.deleteAll(); } catch (e) {}
      this.ipCounter = 2;
      this.lastSaveAt = 0;
      this.community = "";
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
    const publicIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "";

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
          sharePort: p.sharePort || 0,
          natType: p.natType || "unknown",
          turnRelayAddr: p.turnRelayAddr || "",
        };
      });

    let peer = this.peers.get(clientId);
    if (peer) {
      peer.online = true;
      peer.connectedAt = now;
      peer.lastSeen = now;
      peer.disconnectedAt = undefined;
      peer._publicIp = publicIp;
    } else {
      peer = {
        clientId, mac: clientId, name: "",
        virtualIp: this.allocateIp(),
        online: true, connectedAt: now, registeredAt: now, lastSeen: now,
        connections: new Map(),
        pubSocket: "", p2pEndpoint: "", publicEndpoint: "",
        sharePort: 0, natType: "unknown", portsDifference: 0, regularPortsChange: false,
        behavior: "BehaviorPortChanged", assistedSockets: [], observedRaddr: "",
        turnRelayAddr: "", relayBytesIn: 0, relayBytesOut: 0, relayPacketsIn: 0, relayPacketsOut: 0,
        _publicIp: publicIp,
      };
      this.peers.set(clientId, peer);
    }
    this.ipToClient.set(peer.virtualIp, clientId);
    this.sessions.set(clientId, server);

    await this.reportToRegistry(true);
    await this.setupSaveAlarm();
    await this.saveStateNow();

    server.send(JSON.stringify({
      type: "ready", from: clientId,
      payload: {
        id: clientId,
        virtualIp: peer.virtualIp,
        yourPublicIp: publicIp,
        peers: onlinePeersForClient,
        shares: Array.from(this.shareAnnounces.entries())
          .filter(([id]) => { const p = this.peers.get(id); return p && p.online; })
          .map(([id, p]) => ({ id, ...p })),
      },
    }));

    const peerAddr = this.peerPublicAddr(peer);
    this.broadcast(clientId, {
      type: "joined", from: clientId,
      payload: {
        id: clientId,
        virtualIp: peer.virtualIp,
        publicIp: peerAddr.ip,
        publicPort: peerAddr.port,
        sharePort: peer.sharePort || 0,
        natType: peer.natType || "unknown",
        turnRelayAddr: peer.turnRelayAddr || "",
      },
    });

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
      case "ping":
        try { ws.send(JSON.stringify({ type: "pong", from, t: msg.ts || Date.now() })); } catch {}
        return;

      case "connection_status":
        if (peer) peer.connections = new Map(Object.entries(msg.payload?.connections || {}));
        return;

      case "p2p_metadata":
        if (peer) {
          const p = msg.payload || {};
          peer.natType = p.natType || peer.natType;
          peer.portsDifference = p.portsDifference || 0;
          peer.regularPortsChange = !!p.regularPortsChange;
          peer.behavior = p.behavior || peer.behavior;
          peer.assistedSockets = Array.isArray(p.assistedSockets) ? p.assistedSockets : [];
          if (typeof p.p2pEndpoint === "string" && p.p2pEndpoint) peer.p2pEndpoint = p.p2pEndpoint;
          if (typeof p.sharePort === "number" && p.sharePort > 0) peer.sharePort = p.sharePort;
          const publicEndpoint = typeof p.publicEndpoint === "string" ? p.publicEndpoint : "";
          if (publicEndpoint && publicEndpoint !== "") {
            peer.publicEndpoint = publicEndpoint;
            peer.pubSocket = publicEndpoint;
          } else {
            if (!peer.publicEndpoint) peer.pubSocket = "";
          }
          // ★ 同 WiFi 字段
          if (typeof p.lanIp === "string") peer.lanIp = p.lanIp;
          if (typeof p.gatewayIp === "string") peer.gatewayIp = p.gatewayIp;
          if (typeof p.udpPort === "number") peer.udpPort = p.udpPort;
          this.saveStateThrottled();

          const addr = this.peerPublicAddr(peer);
          console.log(`[Room] p2p_metadata from ${from}: natType=${peer.natType} pub=${addr.ip}:${addr.port} lan=${peer.lanIp} gw=${peer.gatewayIp}`);
          if (addr.ip && addr.port > 0) {
            this.broadcast(from, {
              type: "joined", from,
              payload: {
                id: from,
                virtualIp: peer.virtualIp,
                publicIp: addr.ip,
                publicPort: addr.port,
                sharePort: peer.sharePort,
                natType: peer.natType || "unknown",
                turnRelayAddr: peer.turnRelayAddr || "",
              },
            });
          }
        }
        await this.runCoordination();
        // ★ 检查同 WiFi
        this.checkSameWiFi();
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
              this.coordinator.recordPunchResult(from, t.punchResultPeerMac, t.punchResult);
            }
          }
        }
        await this.runCoordination();
        return;

      case "share_announce":
        this.shareAnnounces.set(from, msg.payload);
        if (peer && msg.payload && typeof msg.payload === "object") {
          const sharePayload = msg.payload as any;
          if (typeof sharePayload.name === "string" && sharePayload.name) peer.name = sharePayload.name;
        }
        this.broadcast(from, { ...msg, from });
        this.saveStateThrottled();
        return;

      case "share_withdraw":
        this.shareAnnounces.delete(from);
        this.broadcast(from, { ...msg, from });
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
    if (data[16] !== 10 || data[17] !== 64 || data[18] !== 0) return;

    const from = this.findClientId(ws);
    if (!from) return;
    const dstIp = `${data[16]}.${data[17]}.${data[18]}.${data[19]}`;
    const targetClientId = this.ipToClient.get(dstIp);
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
      if (peer) {
        peer.online = false;
        peer.disconnectedAt = Date.now();
        peer.connections = new Map();
        peer.pubSocket = "";
        peer.p2pEndpoint = "";
        peer.publicEndpoint = "";
      }
      this.sessions.delete(clientId);
      if (peer?.virtualIp) this.ipToClient.delete(peer.virtualIp);
      this.coordinator.clearPairStateFor(clientId);
      this.broadcast(clientId, { type: "left", from: clientId });
      await this.reportToRegistry(true);
      await this.saveStateNow();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ★ 同 WiFi 检测
  private checkSameWiFi(): void {
    const onlinePeers = Array.from(this.peers.values()).filter(p => p.online);
    for (let i = 0; i < onlinePeers.length; i++) {
      for (let j = i + 1; j < onlinePeers.length; j++) {
        const a = onlinePeers[i];
        const b = onlinePeers[j];
        if (!a.gatewayIp || !b.gatewayIp) continue;
        if (a.gatewayIp !== b.gatewayIp) continue;
        if (a.lanIp === b.lanIp) continue;
        if (!a.udpPort || !b.udpPort) continue;

        const stateKey = [a.clientId, b.clientId].sort().join("|");
        if (this.sameWiFiNotified.has(stateKey)) continue;

        const instrToA = {
          type: "lan_direct",
          targetMac: b.clientId,
          targetVirtualIp: b.virtualIp,
          targetLanIp: b.lanIp,
          targetUdpPort: b.udpPort,
        };
        const instrToB = {
          type: "lan_direct",
          targetMac: a.clientId,
          targetVirtualIp: a.virtualIp,
          targetLanIp: a.lanIp,
          targetUdpPort: a.udpPort,
        };

        const wsA = this.sessions.get(a.clientId);
        if (wsA) try { wsA.send(JSON.stringify(instrToA)); } catch {}
        const wsB = this.sessions.get(b.clientId);
        if (wsB) try { wsB.send(JSON.stringify(instrToB)); } catch {}

        this.sameWiFiNotified.add(stateKey);
        console.log(`[Room] 同 WiFi 直连: ${a.clientId} ↔ ${b.clientId} (gw=${a.gatewayIp})`);
      }
    }
  }

  private async runCoordination(): Promise<void> {
    const onlinePeers = Array.from(this.peers.values()).filter((p) => p.online);
    console.log(`[Room] runCoordination: ${onlinePeers.length} 个在线 peer`);

    const community = { getOnlinePeers: () => onlinePeers };
    const instructions = this.coordinator.coordinate(community);
    console.log(`[Room] runCoordination: 生成 ${instructions.size} 条指令`);

    if (instructions.size === 0) return;
    for (const [mac, instr] of instructions) {
      const targetWs = this.sessions.get(mac);
      if (!targetWs) {
        console.warn(`[Room] 目标 ${mac} 无 WebSocket，跳过`);
        continue;
      }
      try {
        targetWs.send(JSON.stringify({ type: "nat_hole_instruction", from: "server", payload: instr }));
      } catch (e) {
        console.error(`[Room] 发送给 ${mac} 失败:`, e);
      }
    }
  }

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
      let p2pCount = 0, relayCount = 0, turnCount = 0;
      for (const t of p.connections.values()) {
        if (t === "p2p") p2pCount++;
        else if (t === "relay") relayCount++;
        else if (t === "turn") turnCount++;
      }
      const relayBytesIn = p.relayBytesIn, relayBytesOut = p.relayBytesOut;

      if (publicOnly) {
        return {
          code, virtualIp: p.online ? p.virtualIp : "",
          online: p.online,
          onlineFor: now - p.connectedAt,
          offlineFor: p.online ? 0 : (p.disconnectedAt ? now - p.disconnectedAt : 0),
          idleFor: now - p.lastSeen,
          p2pCount, relayCount, turnCount,
          connectionsTotal: p2pCount + relayCount + turnCount,
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
        turnRelayAddr: p.turnRelayAddr, sharePort: p.sharePort, natType: p.natType,
        lanIp: p.lanIp, gatewayIp: p.gatewayIp, udpPort: p.udpPort,
        online: p.online, connectedAt: p.connectedAt, lastSeen: p.lastSeen, disconnectedAt: p.disconnectedAt,
        onlineFor: now - p.connectedAt,
        offlineFor: p.online ? 0 : (p.disconnectedAt ? now - p.disconnectedAt : 0),
        idleFor: now - p.lastSeen,
        connections: connectionsByCode,
        p2pCount, relayCount, turnCount,
        relayBytesIn, relayBytesOut,
        relayPacketsIn: p.relayPacketsIn, relayPacketsOut: p.relayPacketsOut,
      };
    });

    return new Response(JSON.stringify({
      community: this.community,
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
        behaviorIndex: v.behaviorIndex,
        ageMs: now - v.at,
      });
    }
    return new Response(JSON.stringify({ now, backoff, punch }, null, 2), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  private async setupSaveAlarm(): Promise<void> {
    let wakeAt = Date.now() + STAGGER_FALLBACK_SAVE_MS;
    const staggerAt = this.coordinator.nextStaggerDeadline();
    if (staggerAt != null && staggerAt < wakeAt) wakeAt = staggerAt;
    await this.ctx.storage.setAlarm(wakeAt);
    this.saveAlarmScheduled = true;
  }

  async alarm(): Promise<void> {
    const pending = this.pendingStaggerAt;
    this.pendingStaggerAt = null;
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
      if (pending != null && this.pendingStaggerAt == null) this.pendingStaggerAt = pending;
      try { await this.setupSaveAlarm(); } catch {}
    }
  }

  private extractPort(endpoint: string): number {
    if (!endpoint) return 0;
    const i = endpoint.lastIndexOf(":");
    if (i < 0) return 0;
    return parseInt(endpoint.slice(i + 1), 10) || 0;
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

  private allocateIp(): string {
    for (let i = 0; i < 254; i++) {
      const ip = `10.64.0.${this.ipCounter}`;
      this.ipCounter++;
      if (this.ipCounter > 254) this.ipCounter = 2;
      if (!this.ipToClient.has(ip)) return ip;
    }
    throw new Error("IP pool exhausted");
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
