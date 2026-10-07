import {
  DetectRoleSender,
  DetectRoleReceiver,
  NAT_HOLE_MODE_EASY_PAIR,
  NAT_HOLE_MODE_HARD_PAIR,
  behaviorsForMode,
} from "./ladder.mjs";
import { NatHoleAnalyzer, pairKeyFor } from "./analyzer.mjs";

const PORTS_RANGE_NUMBER = 10;
const PUNCH_STAGGER_MS_DEFAULT = 1000;
const FAIL_BACKOFF_BASE_MS = 15000;
const FAIL_BACKOFF_CAP_MS = 300000;

function classifyNat(peer) {
  if (!peer || !peer.natType) {
    return { natType: "unknown", portsDifference: 0, regularPortsChange: false, behavior: "BehaviorPortChanged" };
  }
  const t = peer.natType;
  if (t === "EasyNAT") {
    return { natType: "EasyNAT", portsDifference: 0, regularPortsChange: false, behavior: "BehaviorNoChange" };
  }
  return {
    natType: "HardNAT",
    portsDifference: peer.portsDifference || 0,
    regularPortsChange: !!peer.regularPortsChange,
    behavior: peer.behavior || "BehaviorPortChanged",
  };
}

function parsePort(sock) {
  if (!sock) return 0;
  const i = sock.lastIndexOf(":");
  return i < 0 ? 0 : parseInt(sock.slice(i + 1), 10) || 0;
}

function peerKey(p) { return p && p.mac; }

function isIPv6Sock(sock) {
  if (!sock) return false;
  if (sock.includes("[")) return true;
  const colonCount = (sock.match(/:/g) || []).length;
  return colonCount > 1;
}

export class NatHoleCoordinator {
  constructor(env = {}) {
    this.analyzer = new NatHoleAnalyzer();
    this.backoff = new Map();
    this.punchState = new Map();
    this.failCounts = new Map();
    this.lastDispatchedRung = new Map();

    this.staggerMs = parseInt(env.NAT_PUNCH_STAGGER_MS ?? PUNCH_STAGGER_MS_DEFAULT, 10);
  }

  clearPairStateFor(mac) {
    if (!mac) return;
    const needle = String(mac).toLowerCase();
    const touches = (key) => key.split("|").some((m) => m.toLowerCase() === needle);
    for (const k of [...this.backoff.keys()]) if (touches(k)) this.backoff.delete(k);
    for (const k of [...this.punchState.keys()]) if (touches(k)) this.punchState.delete(k);
    for (const k of [...this.failCounts.keys()]) if (touches(k)) this.failCounts.delete(k);
    for (const k of [...this.lastDispatchedRung.keys()]) if (touches(k)) this.lastDispatchedRung.delete(k);
    this.analyzer.forgetMAC(mac);
  }

  recordPunchResult(reporterMAC, peerMAC, result) {
    if (!reporterMAC || !peerMAC || !result) return;
    const key = pairKeyFor(reporterMAC, peerMAC);
    const state = typeof result.state === "number" ? result.state : 0;
    if (state === 0) return;

    const behaviorIndex = typeof result.behaviorIndex === "number"
      ? result.behaviorIndex
      : this.lastDispatchedRung.get(key) ?? null;

    let entry = this.punchState.get(key);
    if (!entry) {
      entry = { aState: 0, bState: 0, aAttempts: 0, bAttempts: 0, behaviorIndex, at: 0 };
      this.punchState.set(key, entry);
    }
    const [a, b] = key.split("|");
    const reporter = String(reporterMAC).toLowerCase();
    if (reporter === a) { entry.aState = state; entry.aAttempts = result.attempts || 0; }
    else if (reporter === b) { entry.bState = state; entry.bAttempts = result.attempts || 0; }
    else return;

    if (behaviorIndex != null) entry.behaviorIndex = behaviorIndex;
    entry.at = Date.now();

    if (state === 3 && entry.aState === 3 && entry.bState === 3) {
      this.backoff.delete(key);
      this.failCounts.delete(key);
    } else if (state === 2) {
      this.failCounts.set(key, (this.failCounts.get(key) || 0) + 1);
    }

    if (behaviorIndex != null && (state === 2 || state === 3)) {
      this.analyzer.report(key, behaviorIndex, state === 3);
    }
  }

  nextStaggerDeadline() {
    let earliest = null;
    const now = Date.now();
    for (const [, entry] of this.backoff) {
      if (!entry || !entry.staggered) continue;
      if (entry.nextAllowedAt <= now) return now;
      if (earliest === null || entry.nextAllowedAt < earliest) earliest = entry.nextAllowedAt;
    }
    return earliest;
  }

  // ★ 收集所有候选对，用最大匹配算法选出本轮要处理的 pair
  //
  // 关键修复：
  //   - 原实现按 node 级去重，A↔B 配对后 A 和 B 都无法再与 C 配对，
  //     导致 3+ 节点 mesh 组网永远打不通
  //   - 改为：收集所有候选对 → 优先未尝试 → 每轮选节点不重复的最大匹配
  //   - 3 个节点：第 1 轮 A↔B，第 2 轮 A↔C 或 B↔C，第 3 轮剩下的
  coordinate(community) {
    const instructions = new Map();
    const online = community.getOnlinePeers();
    if (online.length < 2) return instructions;

    const now = Date.now();

    // ── 1. 收集候选对 ───────────────────────────────
    const candidates = [];

    for (let i = 0; i < online.length; i++) {
      const a = online[i];
      const aKey = peerKey(a);
      if (!aKey) continue;

      for (let j = i + 1; j < online.length; j++) {
        const b = online[j];
        const bKey = peerKey(b);
        if (!bKey) continue;

        const fa = classifyNat(a), fb = classifyNat(b);
        if (fa.natType === "unknown" || fb.natType === "unknown") continue;

        const key = pairKeyFor(aKey, bKey);

        // 已经成功的对跳过
        const prev = this.punchState.get(key);
        if (prev && prev.aState === 3 && prev.bState === 3) continue;

        if (!a.pubSocket || !b.pubSocket) continue;
        if (isIPv6Sock(a.pubSocket) || isIPv6Sock(b.pubSocket)) continue;

        const portA = parsePort(a.pubSocket);
        const portB = parsePort(b.pubSocket);
        const sender = portA <= portB ? a : b;
        const receiver = portA <= portB ? b : a;
        const senderKey = peerKey(sender);
        const receiverKey = peerKey(receiver);
        const senderFeature = classifyNat(sender);
        const receiverFeature = classifyNat(receiver);

        const bothEasy = senderFeature.natType === "EasyNAT" && receiverFeature.natType === "EasyNAT";
        const mode = bothEasy ? NAT_HOLE_MODE_EASY_PAIR : NAT_HOLE_MODE_HARD_PAIR;
        const ladder = behaviorsForMode(mode);
        const rung = this.analyzer.recommend(key);
        const behavior = ladder[Math.min(rung, ladder.length - 1)] || ladder[0];

        const senderBeh = behavior.sender || {};
        const receiverBeh = behavior.receiver || {};

        const senderPort = parsePort(sender.pubSocket);
        const receiverPort = parsePort(receiver.pubSocket);
        const diff = Math.abs(senderFeature.portsDifference - receiverFeature.portsDifference);

        let senderRangeFrom = 0, senderRangeTo = 0;
        let receiverRangeFrom = 0, receiverRangeTo = 0;
        if (!bothEasy) {
          senderRangeFrom = Math.max(1, receiverPort - diff - PORTS_RANGE_NUMBER);
          senderRangeTo = Math.min(65535, receiverPort + diff + PORTS_RANGE_NUMBER);
          receiverRangeFrom = Math.max(1, senderPort - diff - PORTS_RANGE_NUMBER);
          receiverRangeTo = Math.min(65535, senderPort + diff + PORTS_RANGE_NUMBER);
        }

        const shared = {
          mode,
          behaviorIndex: rung,
          senderMac: senderKey,
          senderP2pEndpoint: sender.p2pEndpoint || "",
          senderPubSocket: sender.pubSocket || "",
          senderNatType: senderFeature.natType,
          senderBehavior: senderFeature.behavior,
          senderAssistedEndpoints: sender.assistedSockets || [],
          receiverMac: receiverKey,
          receiverP2pEndpoint: receiver.p2pEndpoint || "",
          receiverPubSocket: receiver.pubSocket || "",
          receiverNatType: receiverFeature.natType,
          receiverAssistedEndpoints: receiver.assistedSockets || [],
          portsDifference: diff,
          regularPortsChange: !!senderFeature.regularPortsChange,
        };

        const senderInstr = {
          role: DetectRoleSender,
          ttl: senderBeh.ttl || 0,
          sendDelayMs: senderBeh.sendDelayMs || 0,
          portsRangeFrom: senderRangeFrom,
          portsRangeTo: senderRangeTo,
          targetMac: receiverKey,
          targetVirtualIp: receiver.virtualIp,
          targetPubSocket: receiver.pubSocket || "",
          targetAssistedEndpoints: receiver.assistedSockets || [],
          ...shared,
        };

        const receiverInstr = {
          role: DetectRoleReceiver,
          ttl: receiverBeh.ttl || 0,
          sendDelayMs: 0,
          portsRangeFrom: receiverRangeFrom,
          portsRangeTo: receiverRangeTo,
          targetMac: senderKey,
          targetVirtualIp: sender.virtualIp,
          targetPubSocket: sender.pubSocket || "",
          targetAssistedEndpoints: sender.assistedSockets || [],
          ...shared,
        };

        // ── 2. 过滤：backoff / 错峰 ─────────────────
        const signature = `${senderKey}->${receiverKey}`;
        const prevBackoff = this.backoff.get(key);
        if (prevBackoff && prevBackoff.signature === signature && now < prevBackoff.nextAllowedAt) {
          continue;
        }

        const fc = this.failCounts.get(key) || 0;
        const regA = a.registeredAt || a.connectedAt || 0;
        const regB = b.registeredAt || b.connectedAt || 0;
        const newestReg = Math.max(regA, regB);
        const readyAt = newestReg + this.staggerMs;
        if (fc === 0 && now < readyAt) {
          this.backoff.set(key, {
            nextAllowedAt: readyAt,
            backoffMs: readyAt - now,
            signature,
            staggered: true,
          });
          continue;
        }

        candidates.push({
          key,
          aKey,
          bKey,
          senderKey,
          receiverKey,
          senderInstr,
          receiverInstr,
          alreadyTried: this.punchState.has(key),
        });
      }
    }

    // ── 3. 优先未尝试的对 ──────────────────────────
    candidates.sort((x, y) => {
      if (x.alreadyTried !== y.alreadyTried) return x.alreadyTried ? 1 : -1;
      return 0;
    });

    // ── 4. 贪心最大匹配：每轮节点不重复 ───────────
    const usedNodes = new Set();
    for (const c of candidates) {
      if (usedNodes.has(c.aKey) || usedNodes.has(c.bKey)) continue;
      usedNodes.add(c.aKey);
      usedNodes.add(c.bKey);

      const fc = this.failCounts.get(c.key) || 0;
      let backoffMs = FAIL_BACKOFF_BASE_MS;
      if (fc > 0) {
        backoffMs = Math.min(FAIL_BACKOFF_BASE_MS * Math.pow(2, fc), FAIL_BACKOFF_CAP_MS);
      }

      this.backoff.set(c.key, {
        nextAllowedAt: now + backoffMs,
        backoffMs,
        signature: `${c.senderKey}->${c.receiverKey}`,
      });
      this.lastDispatchedRung.set(c.key, c.senderInstr.behaviorIndex);

      instructions.set(c.senderKey, c.senderInstr);
      instructions.set(c.receiverKey, c.receiverInstr);
    }

    return instructions;
  }
}
