import {
  DetectRoleSender,
  DetectRoleReceiver,
  NAT_HOLE_MODE_EASY_PAIR,
  NAT_HOLE_MODE_HARD_PAIR,
  behaviorsForMode,
} from "./ladder.js";
import { NatHoleAnalyzer, pairKeyFor } from "./analyzer.js";

const PORTS_RANGE_NUMBER = 10;
const PUNCH_STAGGER_MS_DEFAULT = 1000;
const SENDER_DISPATCH_DELAY_MS_DEFAULT = 1000;

// ★ P0-5：退避上限从 300s 降到 60s。
// 300s 只让一个不可能成功的 pair 空转——每轮打洞都是相同地址、相同
// NAT 映射，等更久不会提高成功率，只会推迟那一次本来就会成功的尝试。
const FAIL_BACKOFF_BASE_MS = 15000;
const FAIL_BACKOFF_CAP_MS = 60000;

// ★ P0-2：派发后等待终态报告的窗口。
// 对端每 2s 上报一次状态，报告到达并写回 punchState 需要一次完整
// 往返。这个常量必须比往返时间长、比 InProgress 窗口短。
const INFLIGHT_TIMEOUT_MS = 10000;

// ★ P0-4：成功记录退役的宽限期。
const SUCCESS_GRACE_MS = 30000;

const CONN_P2P = "p2p";

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

function peerKey(p) {
  return p && p.mac;
}

function isIPv6Sock(sock) {
  if (!sock) return false;
  if (sock.includes("[")) return true;
  const colonCount = (sock.match(/:/g) || []).length;
  return colonCount > 1;
}

/**
 * ★ P0-4：判断一个已记录的成功是否还能代表当前隧道。
 *
 * 判据是双向的：双方当前都不在 P2P（客户端 connection_status 表里
 * 没有 "p2p"），且成功记录已存在超过 SUCCESS_GRACE_MS。
 *
 * 参考 n2ngo-ws-relay 的 shouldRetireSuccess()。它是 2026-09-30 E1<->E2
 * "成功记录永驻、pair 永远被 continue 跳过"bug 的修复。
 */
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

/**
 * ★ P0-2：判断一条已派发但未收到终态报告的指令是否仍在飞行中。
 *
 * 梯级和签名都是判定的一部分：任一变化都意味着该指令已不适用，
 * 必须放行。
 */
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
    // ★ P0-2：已派发但未收到终态报告的指令
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

  /**
   * ★ P0-3：单侧 state===3 即视为 pair 已建立。
   *
   * 客户端在 executeNatHole 里只有在 hasRealTrafficFromAny() 确认收到
   * 对端"真实数据帧"后才上报 3。要求双方都报 3 会让单向可达的 pair
   * 卡死，而单向可达本身不是可修复的状态。
   */
  recordPunchResult(reporterMAC, peerMAC, result) {
    if (!reporterMAC || !peerMAC || !result) return;
    const key = pairKeyFor(reporterMAC, peerMAC);
    const state = typeof result.state === "number" ? result.state : 0;
    if (state === 0) return;

    // 终态报告到达，清 in-flight
    this.inFlight.delete(key);

    const behaviorIndex =
      typeof result.behaviorIndex === "number"
        ? result.behaviorIndex
        : this.lastDispatchedRung.get(key) ?? null;

    let entry = this.punchState.get(key);
    if (!entry) {
      entry = {
        aState: 0, bState: 0,
        aAttempts: 0, bAttempts: 0,
        behaviorIndex,
        at: 0,
      };
      this.punchState.set(key, entry);
    }
    const [a, b] = key.split("|");
    const reporter = String(reporterMAC).toLowerCase();
    if (reporter === a) {
      entry.aState = state;
      entry.aAttempts = result.attempts || 0;
    } else if (reporter === b) {
      entry.bState = state;
      entry.bAttempts = result.attempts || 0;
    } else {
      return;
    }
    if (behaviorIndex != null) entry.behaviorIndex = behaviorIndex;
    entry.at = Date.now();

    // 单侧成功就清 backoff、清 failCounts，让 coordinate() 停下来
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

  /**
   * ★ P0-9：返回一个绝对时间戳，表示下一个需要被唤醒的时刻。
   * 涵盖 staggered 错峰窗口、退避窗口、in-flight 超时。
   */
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

  /**
   * 一次完整的决策遍历。返回 { instructions, wakeAt }。
   */
  coordinate(community) {
    const instructions = new Map();
    const online = community.getOnlinePeers();
    if (online.length < 2) return { instructions, wakeAt: null };

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

        // === ★ P0-4：已成功，检查是否应该退役 ===
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

        if (isIPv6Sock(a.pubSocket) || isIPv6Sock(b.pubSocket)) {
          paired.add(aKey);
          paired.add(bKey);
          continue;
        }

        // === 角色分配 ===
        const portA = parsePort(a.pubSocket);
        const portB = parsePort(b.pubSocket);
        const sender = portA <= portB ? a : b;
        const receiver = portA <= portB ? b : a;
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

        // === ★ P0-1：签名包含梯级 ===
        const signature = `${senderKey}->${receiverKey}@${rung}`;
        const candidate = { rung, signature };

        // === ★ P0-2：in-flight 和解 ===
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

        // === 错峰 ===
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

        // === 退避 ===
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

        // === 生成指令 ===
        const senderBeh = behavior.sender || {};
        const receiverBeh = behavior.receiver || {};

        const senderPort = parsePort(sender.pubSocket);
        const receiverPort = parsePort(receiver.pubSocket);
        const diff = Math.abs(
          senderFeature.portsDifference - receiverFeature.portsDifference
        );

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

        // 退避计算
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
        break;
      }
    }

    return { instructions, wakeAt: earliestWake };
  }
}
