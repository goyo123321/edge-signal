import { mode0Behaviors, mode3Behaviors } from "./ladder.js";

const MAX_LADDER_INDEX = Math.max(
  mode0Behaviors.length,
  mode3Behaviors.length
);
const RESERVE_DURATION_MS = 24 * 60 * 60 * 1000;

class ScoreTable {
  constructor() {
    this.scores = new Map();
    for (let i = 0; i < MAX_LADDER_INDEX; i++) this.scores.set(i, 0);
  }
  get(i) {
    return this.scores.get(i) ?? 0;
  }
  add(i, d) {
    const next = Math.max(-10, Math.min(10, this.get(i) + d));
    this.scores.set(i, next);
    return next;
  }

  /**
   * 最高分优先，平局按梯级偏好排序。
   *
   * 平局策略是关键。未尝试过的梯级都是 0 分，纯粹的"最高分"会让
   * pair 从 rung 0 一路爬到 9——rungs 4/5（no-TTL，长路径唯一能用的）
   * 永远赢不了平局，永远到不了。
   *
   * 偏好顺序：
   *   3 — rung 0：最便宜，对短路径最正确，保持现状不变
   *   2 — rungs 4/5：no-TTL，长路径唯一能用的
   *   1 — 其余 TTL 梯级：只在短路径上有用
   *
   * 这个偏好只重排未尝试过的梯级。已失败的梯级分数低于 0，无论
   * rank 都不会被选中。
   */
  recommend() {
    const rank = (i) => (i === 0 ? 3 : i === 4 || i === 5 ? 2 : 1);
    let best = 0;
    let bestScore = -Infinity;
    let bestRank = -Infinity;
    for (const [i, s] of this.scores) {
      const r = rank(i);
      if (s > bestScore || (s === bestScore && r > bestRank)) {
        bestScore = s;
        bestRank = r;
        best = i;
      }
    }
    return best;
  }
}

export class NatHoleAnalyzer {
  constructor(now = Date.now()) {
    this.records = new Map();
    this.now = now;
  }

  _rec(key) {
    if (!this.records.has(key)) {
      this.records.set(key, {
        table: new ScoreTable(),
        reserveDuration: this.now + RESERVE_DURATION_MS,
      });
    }
    return this.records.get(key);
  }

  recommend(key) {
    return this._rec(key).table.recommend();
  }

  /**
   * 记录一次结果。
   *
   * 惩罚从 -1 改为 -2，与成功 +2 对称。原因：-1 会让一个曾经成功的
   * 梯级掉回 neutral 需要 6 次失败。结合指数退避，实际上 rung 0 会
   * 被反复选中——每次都恰好比未尝试的梯级高一点分。
   * -2 让惩罚对称，一个 rung 掉出 neutral 只需要 3 次失败，在退避的
   * 早期、便宜的几步之内就能完成。
   */
  report(key, index, succeeded) {
    return this._rec(key).table.add(index, succeeded ? 2 : -2);
  }

  forgetMAC(mac) {
    if (!mac) return;
    const needle = String(mac).toLowerCase();
    for (const key of [...this.records.keys()]) {
      if (key.split("|").some((m) => m.toLowerCase() === needle)) {
        this.records.delete(key);
      }
    }
  }

  clean() {
    for (const [k, r] of this.records) {
      if (r.reserveDuration <= this.now) this.records.delete(k);
    }
  }
}

export function pairKeyFor(a, b) {
  return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join("|");
}
