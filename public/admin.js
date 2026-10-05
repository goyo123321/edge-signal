const POLL_INTERVAL_MS = 30000;
const POLL_INTERVAL_HIDDEN_MS = 0;
const POLL_BACKOFF_BASE_MS = 5000;
const POLL_BACKOFF_MULTIPLIER = 2;
const POLL_BACKOFF_MAX_MS = 300000;

const state = { token: "", rooms: [], selectedRoom: null };
let pollTimer = null;
let consecutiveFailures = 0;

function loadToken() {
  const params = new URLSearchParams(location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    sessionStorage.setItem("admin_token", urlToken);
    const url = new URL(location.href);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString());
    return urlToken;
  }
  return sessionStorage.getItem("admin_token") || "";
}
function saveToken(t) { sessionStorage.setItem("admin_token", t); }
function logout() {
  sessionStorage.removeItem("admin_token");
  state.token = "";
  showPrompt();
}

// ★ 修复：token 走 Header
async function apiCall(path, options = {}) {
  const url = new URL(path, location.origin);
  const resp = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": state.token,
    },
  });
  if (resp.status === 401) {
    showToast("Token 无效或已过期", "error");
    logout();
    throw new Error("Unauthorized");
  }
  if (!resp.ok) {
    let body = {};
    try { body = await resp.json(); } catch {}
    const err = new Error(body.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return resp.json();
}

async function fetchRooms() {
  const rooms = await apiCall("/api/admin/rooms");
  return rooms || [];
}

async function fetchRoomStatus(roomName) {
  return apiCall(`/api/admin/status/${encodeURIComponent(roomName)}`);
}

async function clearRoom(roomName) {
  if (!confirm(`确定清空房间 "${roomName}"？`)) return;
  try {
    await apiCall(`/api/admin/clear?room=${encodeURIComponent(roomName)}`, { method: "POST" });
    showToast(`✅ 已清空 "${roomName}"`, "success");
    if (state.selectedRoom === roomName) {
      state.selectedRoom = null;
      document.getElementById("detailSection").style.display = "none";
    }
    await refreshAll();
  } catch (e) {
    if (e.status === 409) {
      const n = e.body?.onlineCount || 0;
      showToast(`❌ 房间有 ${n} 个设备在线`, "error");
    } else {
      showToast(`❌ 清空失败: ${e.message}`, "error");
    }
  }
}

async function kickPeer(roomName, cid) {
  if (!confirm(`确定踢掉该设备？`)) return;
  try {
    await apiCall(`/api/admin/kick?room=${encodeURIComponent(roomName)}&cid=${encodeURIComponent(cid)}`, { method: "POST" });
    showToast(`✅ 已踢出`, "success");
    await refreshAll();
  } catch (e) { showToast(`❌ 踢人失败: ${e.message}`, "error"); }
}

async function clearAll() {
  if (!confirm(`确定清空所有房间？`)) return;
  try {
    const result = await apiCall("/api/admin/clear-all", { method: "POST" });
    let msg = `✅ 已清空 ${result.count} 个房间`;
    if (result.skippedCount > 0) msg += `，跳过 ${result.skippedCount} 个`;
    showToast(msg, "success");
    state.selectedRoom = null;
    document.getElementById("detailSection").style.display = "none";
    await refreshAll();
  } catch (e) { showToast(`❌ 清空失败: ${e.message}`, "error"); }
}

function renderRooms() {
  const c = document.getElementById("roomsList");
  if (!state.rooms.length) { c.innerHTML = '<p class="empty">暂无活跃房间</p>'; return; }
  c.innerHTML = state.rooms.map((r) => {
    const ageStr = fmtDur(Date.now() - r.lastActive);
    const online = r.onlineCount != null ? r.onlineCount : (r.peerCount || 0);
    const offline = r.offlineCount != null ? r.offlineCount : 0;
    const total = r.peerCount || (online + offline);
    const canClear = online === 0;
    const clearBtn = canClear
      ? `<button class="small danger" data-action="clear" data-room="${esc(r.name)}">清空</button>`
      : `<button class="small" disabled style="opacity:0.4">🔒 清空</button>`;
    return `
      <div class="room-card ${state.selectedRoom === r.name ? "active" : ""}" data-room="${esc(r.name)}">
        <div class="name">${esc(r.name)}</div>
        <div class="stats">${total} 个设备 · 在线 ${online} · 离线 ${offline} · ${ageStr} 前活跃</div>
        <div class="row-actions" style="margin-top:12px">${clearBtn}</div>
      </div>`;
  }).join("");
  c.querySelectorAll(".room-card").forEach((el) => {
    el.addEventListener("click", (ev) => {
      const target = ev.target;
      if (target.dataset.action === "clear") {
        ev.stopPropagation();
        clearRoom(target.dataset.room);
        return;
      }
      state.selectedRoom = el.dataset.room;
      renderRooms();
      refreshDetail();
    });
  });
}

async function refreshDetail() {
  if (!state.selectedRoom) return;
  const sec = document.getElementById("detailSection");
  const nameEl = document.getElementById("detailRoomName");
  const content = document.getElementById("detailContent");
  try {
    const status = await fetchRoomStatus(state.selectedRoom);
    sec.style.display = "block";
    nameEl.textContent = status.community;
    if (!status.peers.length) { content.innerHTML = `<p class="empty">房间中没有 Peer</p>`; return; }
    const rows = status.peers.map((p) => {
      const codeNameCell = `
        <div style="display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;min-width:24px;padding:2px 6px;background:#334155;color:#e2e8f0;border-radius:4px;font-weight:700;text-align:center">${esc(p.code)}</span>
          <span>${esc(p.name || "(未命名)")}</span>
        </div>`;
      const ipCell = p.online
        ? `<div class="mono" style="color:#94a3b8;font-size:11px">${esc(p.publicIp || "-")}</div><div class="mono" style="color:#e2e8f0">${esc(p.virtualIp)}</div>`
        : `<span style="color:#64748b">--</span>`;
      const statusBadge = p.online
        ? `<span class="badge online">🟢 在线</span> <span style="color:#94a3b8;font-size:12px">${fmtDur(p.onlineFor)}</span>`
        : `<span class="badge unknown">⚪ 离线</span> <span style="color:#94a3b8;font-size:12px">${fmtDur(p.offlineFor)}</span>`;
      const connStr = p.online ? formatConnStatus(p.connections) : `<span style="color:#64748b">--</span>`;
      const total = (p.relayBytesIn || 0) + (p.relayBytesOut || 0);
      const flowStr = total > 0
        ? `${fmtBytes(total)}<div style="color:#64748b;font-size:11px">↑${fmtBytes(p.relayBytesOut || 0)} ↓${fmtBytes(p.relayBytesIn || 0)}</div>`
        : `<span style="color:#64748b">0 B</span>`;
      const actionCell = p.online
        ? `<button class="small danger" data-action="kick" data-cid="${esc(p.clientId)}">踢出</button>`
        : `<span style="color:#64748b;font-size:11px">--</span>`;
      return `
        <tr style="${p.online ? "" : "opacity:0.6"}">
          <td>${codeNameCell}</td>
          <td class="mono" style="font-size:11px;color:#94a3b8">${esc(p.clientId)}</td>
          <td>${ipCell}</td>
          <td>${natBadge(p.natType)}</td>
          <td>${statusBadge}</td>
          <td>${connStr}</td>
          <td class="bytes">${flowStr}</td>
          <td>${actionCell}</td>
        </tr>`;
    }).join("");
    content.innerHTML = `
      <div style="margin-bottom:12px;color:#94a3b8;font-size:13px">
        共 ${status.peerCount} 个设备 · 在线 ${status.onlineCount} · 离线 ${status.offlineCount}
      </div>
      <table>
        <thead><tr><th>代号/设备名</th><th>Client ID</th><th>公网IP / 虚拟IP</th><th>NAT 类型</th><th>状态</th><th>连接状态</th><th>中继流量</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    content.querySelectorAll('button[data-action="kick"]').forEach((btn) => {
      btn.addEventListener("click", () => kickPeer(state.selectedRoom, btn.dataset.cid));
    });
  } catch (e) {
    content.innerHTML = `<p class="empty">加载失败: ${esc(e.message)}</p>`;
  }
}

function formatConnStatus(connections) {
  if (!connections || Object.keys(connections).length === 0) return `<span style="color:#64748b">--</span>`;
  const p2pList = [], turnList = [], relayList = [];
  for (const [code, type] of Object.entries(connections)) {
    if (type === "p2p") p2pList.push(code);
    else if (type === "turn") turnList.push(code);
    else if (type === "relay") relayList.push(code);
  }
  p2pList.sort(); turnList.sort(); relayList.sort();
  const parts = [];
  if (p2pList.length > 0) parts.push(`<span class="badge p2p">p2p-${p2pList.join("")}</span>`);
  if (turnList.length > 0) parts.push(`<span class="badge turn">TURN-${turnList.join("")}</span>`);
  if (relayList.length > 0) parts.push(`<span class="badge relay">ws-${relayList.join("")}</span>`);
  return parts.join(" ");
}

function natBadge(natType) {
  if (!natType || natType === "unknown") return `<span class="badge unknown">未知</span>`;
  if (natType === "EasyNAT") return `<span class="badge p2p">EasyNAT</span>`;
  if (natType === "HardNAT") return `<span class="badge relay">HardNAT</span>`;
  return `<span class="badge unknown">${esc(natType)}</span>`;
}

function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function showToast(msg, type = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show " + type;
  setTimeout(() => { t.className = "toast " + type; }, 3000);
}
function showPrompt() {
  document.getElementById("tokenPrompt").style.display = "block";
  document.getElementById("content").style.display = "none";
  document.getElementById("detailSection").style.display = "none";
  document.getElementById("tokenInput").value = "";
  document.getElementById("tokenInput").focus();
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}
function showContent() {
  document.getElementById("tokenPrompt").style.display = "none";
  document.getElementById("content").style.display = "block";
  (async () => {
    try { await refreshAll(); consecutiveFailures = 0; }
    catch (e) { consecutiveFailures++; }
    schedulePoll();
  })();
}

async function refreshAll() {
  const rooms = await fetchRooms();
  state.rooms = rooms;
  renderRooms();
  document.getElementById("roomCount").textContent = state.rooms.length;
  document.getElementById("status").textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  if (state.selectedRoom) await refreshDetail();
}

function getPollDelay() {
  if (document.hidden) return POLL_INTERVAL_HIDDEN_MS;
  if (consecutiveFailures > 0) {
    const delay = POLL_BACKOFF_BASE_MS * Math.pow(POLL_BACKOFF_MULTIPLIER, consecutiveFailures - 1);
    return Math.min(delay, POLL_BACKOFF_MAX_MS);
  }
  return POLL_INTERVAL_MS;
}

function schedulePoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!state.token) return;
  const delay = getPollDelay();
  if (delay <= 0) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try { await refreshAll(); consecutiveFailures = 0; }
    catch (e) {
      consecutiveFailures++;
      if (e.message === "Unauthorized") return;
    }
    schedulePoll();
  }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (!state.token) return;
  if (!document.hidden) {
    (async () => {
      try { await refreshAll(); consecutiveFailures = 0; }
      catch (e) { consecutiveFailures++; }
      schedulePoll();
    })();
  } else {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    schedulePoll();
  }
});

document.getElementById("tokenSubmit").addEventListener("click", () => {
  const t = document.getElementById("tokenInput").value.trim();
  if (!t) { showToast("Token 不能为空", "error"); return; }
  state.token = t;
  saveToken(t);
  showContent();
});
document.getElementById("tokenInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("tokenSubmit").click();
});
document.getElementById("refreshBtn").addEventListener("click", async () => {
  try { await refreshAll(); consecutiveFailures = 0; } catch (e) {}
  schedulePoll();
});
document.getElementById("clearAllBtn").addEventListener("click", clearAll);
document.getElementById("logoutBtn").addEventListener("click", logout);

state.token = loadToken();
if (state.token) showContent();
else showPrompt();
