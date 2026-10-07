import { mode0Behaviors, mode3Behaviors } from "./ladder.mjs";

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
  recommend() {
    let best = 0;
    let bestScore = -Infinity;
    for (const [i, s] of this.scores) {
      if (s > bestScore) {
        bestScore = s;
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

  report(key, index, succeeded) {
    return this._rec(key).table.add(index, succeeded ? 2 : -1);
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
