import {
  DetectRoleSender,
  DetectRoleReceiver,
  NAT_HOLE_MODE_EASY_PAIR,
  NAT_HOLE_MODE_HARD_PAIR,
  behaviorsForMode,
} from "./ladder.js";
import { NatHoleAnalyzer, pairKeyFor } from "./analyzer.js";

const PUNCH_STAGGER_MS_DEFAULT = 1000;
const SENDER_DISPATCH_DELAY_MS_DEFAULT = 1000;
const FAIL_BACKOFF_BASE_MS = 15000;
const FAIL_BACKOFF_CAP_MS = 60000;
const INFLIGHT_TIMEOUT_MS = 10000;
const SUCCESS_GRACE_MS = 30000;

const CONN_P2P = "p2p";
const P2P_AVAILABLE = 2;
const P2P_FULLDUPLEX = 3;

// 端口扫描范围的固定缓冲与上限。
const PORTS_RANGE_NARROW = 100;
const PORTS_RANGE_MAX = 10000;

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
  if (i < 0) return sock;
  return sock.slice(0, i);
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

  getSenderDelayMs() {
    return this.senderDelayMs;
  }

  clearPairStateFor(mac) {
    if (!mac) return;
    const needle = String(mac).toLowerCase();
    const touches = (key) => {
      // key 可能是 "a|b" 也可能是 "a@r"（instructions 用），统一检查
      const base = key.includes("@") ? key.split("@")[0] : key;
      return base.split("|").some((m) => m.toLowerCase() === needle);
    };
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

    // InProgress：刷新 in-flight 窗口
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

    // 首次成功的交叉校验：接受 p2pStatus >= P2PAvailable(2)
    if (state === 3) {
      if (!entry.everValidated) {
        const otherP2PStatus = isA ? entry.bP2PStatus : entry.aP2PStatus;
        const corroborated =
          selfP2PStatus >= P2P_AVAILABLE ||
          otherP2PStatus >= P2P_AVAILABLE;

        if (!corroborated) {
          console.log(
            `[NAT] ${key} 拒绝未证实的首次成功：` +
            `self=${selfP2PStatus} other=${otherP2PStatus}（双方都未达到 P2PAvailable，降级为失败）`
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
            `(self=${selfP2PStatus} other=${otherP2PStatus}，≥P2PAvailable 即通过)`
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
    // 定期清理过期的 analyzer 记录
    this.analyzer.clean();

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

        const key = pairKeyFor(aKey, bKey);

        // 任一端成功即视为已建立，进入退役判定或跳过
        const prevPunch = this.punchState.get(key);
        const anySucceeded = prevPunch &&
          (prevPunch.aState === 3 || prevPunch.bState === 3);
        if (anySucceeded) {
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

        // 同 STUN 出口 IP 检测
        const aIp = extractIP(a.pubSocket);
        const bIp = extractIP(b.pubSocket);
        if (aIp && bIp && aIp === bIp) {
          const alreadyFailed =
            (prevPunch &&
              (prevPunch.aState === 2 || prevPunch.bState === 2)) ||
            (this.failCounts.get(key) || 0) > 0;

          const alreadySucceeded = prevPunch &&
            (prevPunch.aState === 3 || prevPunch.bState === 3);

          if (alreadySucceeded) {
            // 上方 anySucceeded 分支已处理
          } else if (alreadyFailed) {
            if (!forceFallbacks.has(aKey)) forceFallbacks.set(aKey, new Set());
            if (!forceFallbacks.has(bKey)) forceFallbacks.set(bKey, new Set());
            forceFallbacks.get(aKey).add(bKey);
            forceFallbacks.get(bKey).add(aKey);
            paired.add(aKey);
            paired.add(bKey);
            console.log(
              `[NAT] ${key} 同 STUN 出口 IP (${aIp}) 已尝试失败，` +
              `下发 force_fallback 强制降级`
            );
            continue;
          } else {
            console.log(
              `[NAT] ${key} 同 STUN 出口 IP (${aIp})，允许一次 hairpin 尝试`
            );
            // fall through 到正常打洞流程
          }
        }

        const aPort = parsePort(a.pubSocket);
        const bPort = parsePort(b.pubSocket);
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

        // 首轮错峰：给最新注册的 peer 留 NAT 映射建立时间
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

        // 同 signature 的退避窗口内，抑制重复派发
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

        // 端口扫描范围 = max(NAT 行为差异, 两端端口差) + 缓冲
        const natDiff = Math.abs(
          (senderFeature.portsDifference || 0) - (receiverFeature.portsDifference || 0)
        );
        const portGap = Math.abs(aPort - bPort);
        let halfWidth = Math.max(natDiff, portGap) + PORTS_RANGE_NARROW;
        if (halfWidth < PORTS_RANGE_NARROW) halfWidth = PORTS_RANGE_NARROW;
        if (halfWidth > PORTS_RANGE_MAX) halfWidth = PORTS_RANGE_MAX;

        const senderRangeFrom = Math.max(1, bPort - halfWidth);
        const senderRangeTo = Math.min(65535, bPort + halfWidth);
        const receiverRangeFrom = Math.max(1, aPort - halfWidth);
        const receiverRangeTo = Math.min(65535, aPort + halfWidth);

        const shared = {
          mode,
          behaviorIndex: rung,
          senderMac: senderKey,
          senderP2pEndpoint: sender.p2pEndpoint || "",
          senderPubSocket: sender.pubSocket || "",
          senderNatType: senderFeature.natType,
          senderBehavior: senderFeature.behavior,
          senderAssistedEndpoints: sender.assistedSockets || [],
          senderLanEndpoints: sender.lanEndpoints || [],
          receiverMac: receiverKey,
          receiverP2pEndpoint: receiver.p2pEndpoint || "",
          receiverPubSocket: receiver.pubSocket || "",
          receiverNatType: receiverFeature.natType,
          receiverAssistedEndpoints: receiver.assistedSockets || [],
          receiverLanEndpoints: receiver.lanEndpoints || [],
          portsDifference: 0,
          regularPortsChange: false,
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
          targetLanEndpoints: receiver.lanEndpoints || [],
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
          targetLanEndpoints: sender.lanEndpoints || [],
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

        // ============================================================
        // ★ P0-1 打洞并行化
        //
        // 首次打洞（fc === 0）：一次派发 3 个 rung（rung, rung+1, rung+2）
        //   - 客户端并行执行，任一成功即停
        //   - 首次命中时间从 15s（等退避）降到 500ms 内
        //
        // 重试（fc > 0）：只派发当前推荐的 1 组
        //   - 避免浪费，因为已经知道这个 rung 不行
        //
        // instructions 的 key 用 `${mac}@${r}` 后缀，允许同一 peer 多 rung 并存
        // room.ts 的 runCoordination 会解析 @r 后缀取真实 clientId
        // ============================================================
        const isFirstAttempt = fc === 0;
        const rungsToDispatch = isFirstAttempt
          ? [
              rung,
              Math.min(rung + 1, ladder.length - 1),
              Math.min(rung + 2, ladder.length - 1),
            ]
          : [rung];

        const seenRungs = new Set();
        for (const r of rungsToDispatch) {
          if (seenRungs.has(r)) continue;
          seenRungs.add(r);

          const behR = ladder[Math.min(r, ladder.length - 1)] || ladder[0];
          const senderBehR = behR.sender || {};
          const receiverBehR = behR.receiver || {};

          const senderInstrR = {
            ...senderInstr,
            behaviorIndex: r,
            ttl: senderBehR.ttl || 0,
            sendDelayMs: senderBehR.sendDelayMs || 0,
          };

          const receiverInstrR = {
            ...receiverInstr,
            behaviorIndex: r,
            ttl: receiverBehR.ttl || 0,
            sendDelayMs: 0,
          };

          instructions.set(`${senderKey}@${r}`, senderInstrR);
          instructions.set(`${receiverKey}@${r}`, receiverInstrR);
        }

        paired.add(senderKey);
        paired.add(receiverKey);
        noteWake(now + backoffMs);

        console.log(
          `[NAT] ${key} 生成指令 (rung ${rung}, 派发 ${rungsToDispatch.length} 组)` +
          `, sender=${sender.pubSocket} receiver=${receiver.pubSocket} ` +
          `halfWidth=±${halfWidth} ` +
          `assisted=${(receiver.assistedSockets || []).length}/${(sender.assistedSockets || []).length} ` +
          `lan=${(receiver.lanEndpoints || []).length}/${(sender.lanEndpoints || []).length}`
        );

        break;
      }
    }

    return { instructions, forceFallbacks, wakeAt: earliestWake };
  }
}
