import {
  DetectRoleSender,
  DetectRoleReceiver,
  NAT_HOLE_MODE_EASY_PAIR,
  NAT_HOLE_MODE_HARD_PAIR,
  behaviorsForMode,
} from "./ladder.js";
import { NatHoleAnalyzer, pairKeyFor } from "./analyzer.js";

const PORTS_RANGE_NUMBER = 10;
const PORTS_RANGE_NARROW = 3;
const PUNCH_STAGGER_MS_DEFAULT = 1000;
const SENDER_DISPATCH_DELAY_MS_DEFAULT = 1000;
const FAIL_BACKOFF_BASE_MS = 15000;
const FAIL_BACKOFF_CAP_MS = 60000;
const INFLIGHT_TIMEOUT_MS = 10000;
const SUCCESS_GRACE_MS = 30000;

// ★ 跨 ISP 判定阈值
const CROSS_ISP_PORT_GAP_THRESHOLD = 1000;

const CONN_P2P = "p2p";
const P2P_FULLDUPLEX = 3;

function classifyNat(peer) {
  if (!peer || !peer.natType) {
    return {
      natType: "unknown",
      portsDifference: 0,
      regularPortsChange: false,
      behavior: "BehaviorPortChanged",
    };
  }
  const t = peer.natType;
  if (t === "EasyNAT") {
    return {
      natType: "EasyNAT",
      portsDifference: 0,
      regularPortsChange: false,
      behavior: "BehaviorNoChange",
    };
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

function extractIP(sock) {
  if (!sock) return "";
  const i = sock.lastIndexOf(":");
  return i < 0 ? "" : sock.slice(0, i);
}

function peerKey(p) {
  return p && p.mac;
}

function isIPv6Sock(sock) {
  if (!sock) return false;
  if (sock.includes("[")) return true;
  const colonCount = (sock.match(/:/g) || []).length;
  return colonCount > 1;
}

// ============ LAN 相关 ============

function isSameSubnet24(ipA, ipB) {
  if (!ipA || !ipB) return false;
  const a = String(ipA).split(".");
  const b = String(ipB).split(".");
  if (a.length !== 4 || b.length !== 4) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function checkLanOverlap(a, b) {
  const aLanIPs = Array.isArray(a.lanIps) ? a.lanIps : [];
  const bLanIPs = Array.isArray(b.lanIps) ? b.lanIps : [];
  if (aLanIPs.length === 0 || bLanIPs.length === 0) return null;
  for (const aIp of aLanIPs) {
    for (const bIp of bLanIPs) {
      if (isSameSubnet24(aIp, bIp)) return { aIp, bIp };
    }
  }
  return null;
}

function buildLanEndpoints(peer) {
  if (!peer || !Array.isArray(peer.lanIps) || peer.lanIps.length === 0) {
    return [];
  }
  const port = peer.lanPort || 0;
  if (port <= 0) return [];
  return peer.lanIps
    .filter((ip) => typeof ip === "string" && ip)
    .map((ip) => `${ip}:${port}`);
}

// ============ 其他辅助 ============

function shouldRetireSuccess(prev, a, b, now) {
  if (!prev) return false;
  if (prev.aState !== 3 && prev.bState !== 3) return false;
  if (now - (prev.at || 0) < SUCCESS_GRACE_MS) return false;

  const keyOf = (p) => p.clientId || p.mac || "";
  const aConns = a.connections;
  const bConns = b.connections;
  const aToB = aConns && typeof aConns.get === "function"
    ? aConns.get(keyOf(b))
    : undefined;
  const bToA = bConns && typeof bConns.get === "function"
    ? bConns.get(keyOf(a))
    : undefined;

  return aToB !== CONN_P2P && bToA !== CONN_P2P;
}

function shouldHoldForInFlight(flight, candidate, now, timeoutMs = INFLIGHT_TIMEOUT_MS) {
  if (!flight) return { hold: false, reason: "nothing-in-flight" };
  if (flight.rung !== candidate.rung) {
    return { hold: false, reason: "rung-changed" };
  }
  if (flight.signature !== candidate.signature) {
    return { hold: false, reason: "signature-changed" };
  }
  const deadline = (flight.at || 0) + timeoutMs;
  if (now >= deadline) {
    return { hold: false, reason: "no-verdict" };
  }
  return {
    hold: true,
    reason: "dispatched-awaiting-verdict",
    wakeAt: deadline,
  };
}

export class NatHoleCoordinator {
  constructor(env = {}) {
    this.analyzer = new NatHoleAnalyzer();
    this.backoff = new Map();
    this.punchState = new Map();
    this.failCounts = new Map();
    this.lastDispatchedRung = new Map();
    this.inFlight = new Map();

    this.staggerMs = parseInt(
      env.NAT_PUNCH_STAGGER_MS ?? PUNCH_STAGGER_MS_DEFAULT,
      10
    );
    this.senderDelayMs = parseInt(
      env.NAT_SENDER_DISPATCH_DELAY_MS ?? SENDER_DISPATCH_DELAY_MS_DEFAULT,
      10
    );
  }

  clearPairStateFor(mac) {
    if (!mac) return;
    const needle = String(mac).toLowerCase();
    const touches = (key) =>
      key.split("|").some((m) => m.toLowerCase() === needle);
    for (const k of [...this.backoff.keys()]) if (touches(k)) this.backoff.delete(k);
    for (const k of [...this.punchState.keys()]) if (touches(k)) this.punchState.delete(k);
    for (const k of [...this.failCounts.keys()]) if (touches(k)) this.failCounts.delete(k);
    for (const k of [...this.lastDispatchedRung.keys()]) if (touches(k)) this.lastDispatchedRung.delete(k);
    for (const k of [...this.inFlight.keys()]) if (touches(k)) this.inFlight.delete(k);
    this.analyzer.forgetMAC(mac);
  }

  recordPunchResult(reporterMAC, peerMAC, result, selfP2PStatus = 0) {
    if (!reporterMAC || !peerMAC || !result) return;
    const key = pairKeyFor(reporterMAC, peerMAC);
    let state = typeof result.state === "number" ? result.state : 0;
    if (state === 0) return;

    if (state === 1) {
      const flight = this.inFlight.get(key);
      if (flight) {
        flight.at = Date.now();
        console.log(
          `[NAT] ${key} InProgress：刷新 in-flight 窗口 (rung ${flight.rung})`
        );
      }
      return;
    }

    this.inFlight.delete(key);

    let entry = this.punchState.get(key);
    if (!entry) {
      entry = {
        aState: 0, bState: 0,
        aAttempts: 0, bAttempts: 0,
        aP2PStatus: 0, bP2PStatus: 0,
        behaviorIndex: null,
        at: 0,
        everValidated: false,
      };
      this.punchState.set(key, entry);
    }

    const [a, b] = key.split("|");
    const reporter = String(reporterMAC).toLowerCase();
    const isA = reporter === a;
    if (!isA && reporter !== b) return;

    if (isA) {
      entry.aP2PStatus = selfP2PStatus;
    } else {
      entry.bP2PStatus = selfP2PStatus;
    }

    if (state === 3) {
      if (!entry.everValidated) {
        const otherP2PStatus = isA ? entry.bP2PStatus : entry.aP2PStatus;
        const corroborated =
          selfP2PStatus === P2P_FULLDUPLEX ||
          otherP2PStatus === P2P_FULLDUPLEX;

        if (!corroborated) {
          console.log(
            `[NAT] ${key} 拒绝未证实的首次成功：` +
            `self=${selfP2PStatus} other=${otherP2PStatus}（降级为失败）`
          );
          state = 2;
          result = {
            ...result,
            detail: `uncorroborated-first(self=${selfP2PStatus} other=${otherP2PStatus}): ${result.detail || ""}`.trim(),
          };
        } else {
          entry.everValidated = true;
          console.log(
            `[NAT] ${key} 首次成功通过交叉校验 ` +
            `(self=${selfP2PStatus} other=${otherP2PStatus})，后续不再重复校验`
          );
        }
      }
    }

    if (isA) {
      entry.aState = state;
      entry.aAttempts = result.attempts || 0;
    } else {
      entry.bState = state;
      entry.bAttempts = result.attempts || 0;
    }

    const behaviorIndex =
      typeof result.behaviorIndex === "number"
        ? result.behaviorIndex
        : this.lastDispatchedRung.get(key) ?? null;
    if (behaviorIndex != null) entry.behaviorIndex = behaviorIndex;
    entry.at = Date.now();

    if (state === 3) {
      this.backoff.delete(key);
      this.failCounts.delete(key);
    } else if (state === 2) {
      this.failCounts.set(key, (this.failCounts.get(key) || 0) + 1);
    }

    if (behaviorIndex != null && (state === 2 || state === 3)) {
      this.analyzer.report(key, behaviorIndex, state === 3);
    }
  }

  nextWakeDeadline() {
    let earliest = null;
    const now = Date.now();
    for (const [, entry] of this.backoff) {
      if (!entry) continue;
      if (entry.nextAllowedAt <= now) return now;
      if (earliest === null || entry.nextAllowedAt < earliest) {
        earliest = entry.nextAllowedAt;
      }
    }
    for (const [, flight] of this.inFlight) {
      const deadline = (flight.at || 0) + INFLIGHT_TIMEOUT_MS;
      if (deadline <= now) return now;
      if (earliest === null || deadline < earliest) earliest = deadline;
    }
    return earliest;
  }

  coordinate(community) {
    const instructions = new Map();
    const forceFallbacks = new Map();
    const online = community.getOnlinePeers();
    if (online.length < 2) return { instructions, forceFallbacks, wakeAt: null };

    const now = Date.now();
    const paired = new Set();
    let earliestWake = null;
    const noteWake = (t) => {
      if (t == null) return;
      if (earliestWake === null || t < earliestWake) earliestWake = t;
    };

    for (let i = 0; i < online.length; i++) {
      const a = online[i];
      const aKey = peerKey(a);
      if (!aKey || paired.has(aKey)) continue;

      for (let j = i + 1; j < online.length; j++) {
        const b = online[j];
        const bKey = peerKey(b);
        if (!bKey || paired.has(bKey)) continue;

        const fa = classifyNat(a);
        const fb = classifyNat(b);
        if (fa.natType === "unknown" || fb.natType === "unknown") continue;

        const key = pairKeyFor(aKey, bKey);

        // ============ ★ 跨 ISP 检测 ============
        // 两端 pubSocket 公网 IP 不同，且都不是私网，且端口差 > 1000 ——
        // 这种场景打洞几乎不可能成功（CGNAT 映射已经完全漂移/不同运营商出口），
        // 直接下发 force_fallback，避免客户端白跑几十秒打洞。
        const aPubIP = extractIP(a.pubSocket);
        const bPubIP = extractIP(b.pubSocket);
        const aPort = parsePort(a.pubSocket);
        const bPort = parsePort(b.pubSocket);
        const portGap = Math.abs(aPort - bPort);

        const isDifferentPublicIP = aPubIP && bPubIP && aPubIP !== bPubIP;
        const isCrossISP = isDifferentPublicIP &&
          portGap > CROSS_ISP_PORT_GAP_THRESHOLD;

        if (isCrossISP) {
          const fc = this.failCounts.get(key) || 0;
          if (fc < 1) {
            console.log(
              `[NAT] ${key} 跨 ISP (${aPubIP}:${aPort} ↔ ${bPubIP}:${bPort}, ` +
              `gap=${portGap})，直接降级到中继`
            );
            this.failCounts.set(key, 1);
            this.punchState.set(key, {
              aState: 2, bState: 2,
              aAttempts: 0, bAttempts: 0,
              aP2PStatus: 0, bP2PStatus: 0,
              behaviorIndex: null,
              at: now,
              everValidated: false,
            });
            if (!forceFallbacks.has(aKey)) forceFallbacks.set(aKey, new Set());
            if (!forceFallbacks.has(bKey)) forceFallbacks.set(bKey, new Set());
            forceFallbacks.get(aKey).add(bKey);
            forceFallbacks.get(bKey).add(aKey);
          }
          paired.add(aKey);
          paired.add(bKey);
          continue;
        }

        // ============ 已有 P2P 成功记录 ============
        const prevPunch = this.punchState.get(key);
        if (prevPunch && (prevPunch.aState === 3 || prevPunch.bState === 3)) {
          if (shouldRetireSuccess(prevPunch, a, b, now)) {
            this.punchState.delete(key);
            this.failCounts.delete(key);
            this.backoff.delete(key);
            this.inFlight.delete(key);
            console.log(
              `[NAT] ${key} 成功记录已过期（双方都不在 P2P），重新协调`
            );
          } else {
            paired.add(aKey);
            paired.add(bKey);
            continue;
          }
        }

        if (!a.pubSocket || !b.pubSocket) continue;

        // 端口为 0 视为无效
        if (parsePort(a.pubSocket) <= 0 || parsePort(b.pubSocket) <= 0) {
          console.log(
            `[NAT] ${key} 跳过：pubSocket 端口无效 ` +
            `a=${a.pubSocket} b=${b.pubSocket}`
          );
          paired.add(aKey);
          paired.add(bKey);
          continue;
        }

        if (isIPv6Sock(a.pubSocket) || isIPv6Sock(b.pubSocket)) {
          paired.add(aKey);
          paired.add(bKey);
          continue;
        }

        // ============ 同 STUN 出口 IP 处理 ============
        const sameStunIP = aPubIP && bPubIP && aPubIP === bPubIP;

        if (sameStunIP) {
          const lanOverlap = checkLanOverlap(a, b);
          const fc = this.failCounts.get(key) || 0;

          if (lanOverlap) {
            console.log(
              `[NAT] ${key} 同 STUN IP (${aPubIP}) 但 LAN 同网段 ` +
              `(${lanOverlap.aIp} ↔ ${lanOverlap.bIp})，走 LAN 直连`
            );
          } else if (fc === 0) {
            console.log(
              `[NAT] ${key} 同 STUN IP (${aPubIP})，允许一次 hairpin 尝试 ` +
              `（部分 CGNAT 支持 hairpin，成功则走 P2P）`
            );
          } else {
            console.log(
              `[NAT] ${key} 跳过：同 STUN IP (${aPubIP}) 已尝试失败，标记强制降级`
            );
            this.failCounts.set(key, fc + 1);
            this.punchState.set(key, {
              aState: 2, bState: 2,
              aAttempts: 0, bAttempts: 0,
              aP2PStatus: 0, bP2PStatus: 0,
              behaviorIndex: null,
              at: now,
              everValidated: false,
            });
            if (!forceFallbacks.has(aKey)) forceFallbacks.set(aKey, new Set());
            if (!forceFallbacks.has(bKey)) forceFallbacks.set(bKey, new Set());
            forceFallbacks.get(aKey).add(bKey);
            forceFallbacks.get(bKey).add(aKey);
            paired.add(aKey);
            paired.add(bKey);
            continue;
          }
        }

        const sender = aPort <= bPort ? a : b;
        const receiver = aPort <= bPort ? b : a;
        const senderKey = peerKey(sender);
        const receiverKey = peerKey(receiver);
        const senderFeature = classifyNat(sender);
        const receiverFeature = classifyNat(receiver);

        const bothEasy =
          senderFeature.natType === "EasyNAT" &&
          receiverFeature.natType === "EasyNAT";
        const mode = bothEasy ? NAT_HOLE_MODE_EASY_PAIR : NAT_HOLE_MODE_HARD_PAIR;
        const ladder = behaviorsForMode(mode);
        const rung = this.analyzer.recommend(key);
        const behavior =
          ladder[Math.min(rung, ladder.length - 1)] || ladder[0];

        const signature = `${senderKey}->${receiverKey}@${rung}`;
        const candidate = { rung, signature };

        const flightEntry = this.inFlight.get(key);
        if (
          flightEntry &&
          prevPunch &&
          (prevPunch.aState === 2 ||
            prevPunch.aState === 3 ||
            prevPunch.bState === 2 ||
            prevPunch.bState === 3 ||
            (prevPunch.at || 0) >= (flightEntry.at || 0))
        ) {
          this.inFlight.delete(key);
        }

        const flightHold = shouldHoldForInFlight(
          this.inFlight.get(key),
          candidate,
          now
        );
        if (flightHold.hold) {
          paired.add(aKey);
          paired.add(bKey);
          noteWake(flightHold.wakeAt);
          continue;
        }

        const backoffEntry = this.backoff.get(key);
        if (
          backoffEntry &&
          backoffEntry.staggered &&
          backoffEntry.nextAllowedAt <= now
        ) {
          this.backoff.delete(key);
        }

        const fc = this.failCounts.get(key) || 0;
        if (fc === 0) {
          const regA = a.registeredAt || a.connectedAt || 0;
          const regB = b.registeredAt || b.connectedAt || 0;
          const newestReg = Math.max(regA, regB);
          const readyAt = newestReg + this.staggerMs;
          if (now < readyAt) {
            this.backoff.set(key, {
              nextAllowedAt: readyAt,
              backoffMs: readyAt - now,
              signature,
              staggered: true,
            });
            paired.add(aKey);
            paired.add(bKey);
            noteWake(readyAt);
            continue;
          }
        }

        if (
          backoffEntry &&
          backoffEntry.signature === signature &&
          now < backoffEntry.nextAllowedAt
        ) {
          paired.add(aKey);
          paired.add(bKey);
          noteWake(backoffEntry.nextAllowedAt);
          continue;
        }

        const senderBeh = behavior.sender || {};
        const receiverBeh = behavior.receiver || {};

        const senderPort = parsePort(sender.pubSocket);
        const receiverPort = parsePort(receiver.pubSocket);

        const natDiff = Math.abs(
          senderFeature.portsDifference - receiverFeature.portsDifference
        );
        const senderReceiverGap = Math.abs(senderPort - receiverPort);

        let halfWidth = Math.max(natDiff, senderReceiverGap) + PORTS_RANGE_NARROW;
        if (halfWidth > 100) halfWidth = 100;

        let senderRangeFrom = 0, senderRangeTo = 0;
        let receiverRangeFrom = 0, receiverRangeTo = 0;
        if (!bothEasy) {
          senderRangeFrom = Math.max(1, receiverPort - halfWidth);
          senderRangeTo = Math.min(65535, receiverPort + halfWidth);
          receiverRangeFrom = Math.max(1, senderPort - halfWidth);
          receiverRangeTo = Math.min(65535, senderPort + halfWidth);
        }

        const senderLanEndpoints = buildLanEndpoints(sender);
        const receiverLanEndpoints = buildLanEndpoints(receiver);

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
          portsDifference: Math.max(natDiff, senderReceiverGap),
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
          targetLanEndpoints: receiverLanEndpoints,
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
          targetLanEndpoints: senderLanEndpoints,
          ...shared,
        };

        let backoffMs;
        if (fc > 0) {
          backoffMs = Math.min(
            FAIL_BACKOFF_BASE_MS * Math.pow(2, fc),
            FAIL_BACKOFF_CAP_MS
          );
        } else {
          backoffMs = FAIL_BACKOFF_BASE_MS;
        }

        this.backoff.set(key, {
          nextAllowedAt: now + backoffMs,
          backoffMs,
          signature,
        });
        this.lastDispatchedRung.set(key, rung);
        this.inFlight.set(key, {
          rung,
          signature,
          at: now,
        });

        instructions.set(senderKey, senderInstr);
        instructions.set(receiverKey, receiverInstr);
        paired.add(senderKey);
        paired.add(receiverKey);
        noteWake(now + backoffMs);

        if (senderLanEndpoints.length > 0 || receiverLanEndpoints.length > 0) {
          console.log(
            `[NAT] ${key} 生成指令 (rung ${rung}), ` +
            `LAN 候选: sender→recv=${receiverLanEndpoints.length} recv→sender=${senderLanEndpoints.length}, ` +
            `halfWidth=${halfWidth}`
          );
        }

        break;
      }
    }

    return { instructions, forceFallbacks, wakeAt: earliestWake };
  }
}
