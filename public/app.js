const state = { rooms: [], selectedRoom: null };

async function fetchRooms() {
  try {
    const r = await fetch("/api/public/rooms");
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

async function fetchRoomStatus(name) {
  try {
    const r = await fetch(`/api/public/status/${encodeURIComponent(name)}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
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

function natBadge(natType) {
  if (!natType || natType === "unknown") {
    return `<span class="badge unknown">未知</span>`;
  }
  if (natType === "EasyNAT") {
    return `<span class="badge p2p">EasyNAT</span>`;
  }
  if (natType === "HardNAT") {
    return `<span class="badge relay">HardNAT</span>`;
  }
  return `<span class="badge unknown">${esc(natType)}</span>`;
}

function formatConnStatus(connections) {
  if (!connections || Object.keys(connections).length === 0) {
    return `<span style="color:#64748b">--</span>`;
  }
  const p2pList = [];
  const turnList = [];
  const relayList = [];
  for (const [code, type] of Object.entries(connections)) {
    if (type === "p2p") p2pList.push(code);
    else if (type === "turn") turnList.push(code);
    else if (type === "relay") relayList.push(code);
  }
  p2pList.sort();
  turnList.sort();
  relayList.sort();
  const parts = [];
  if (p2pList.length > 0) {
    parts.push(`<span class="badge p2p">p2p-${p2pList.join("")}</span>`);
  }
  if (turnList.length > 0) {
    parts.push(`<span class="badge turn">TURN-${turnList.join("")}</span>`);
  }
  if (relayList.length > 0) {
    parts.push(`<span class="badge relay">ws-${relayList.join("")}</span>`);
  }
  return parts.join(" ");
}

function renderRooms(rooms) {
  const c = document.getElementById("roomsList");
  if (!rooms.length) {
    c.innerHTML = `<p class="empty">暂无活跃房间</p>`;
    return;
  }
  c.innerHTML = rooms.map((r) => {
    const total = r.peerCount || 0;
    const online = r.onlineCount != null ? r.onlineCount : total;
    const offline = r.offlineCount != null ? r.offlineCount : 0;
    return `
      <div class="room-card ${state.selectedRoom === r.name ? "active" : ""}" data-room="${esc(r.name)}">
        <div class="name">${esc(r.name)}</div>
        <div class="stats">${total} 个设备 · 在线 ${online} · 离线 ${offline}</div>
        <div class="stats">${fmtDur(Date.now() - r.lastActive)} 前活跃</div>
      </div>
    `;
  }).join("");

  c.querySelectorAll(".room-card").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedRoom = el.dataset.room;
      renderRooms(state.rooms);
      refreshDetail();
    });
  });
}

function renderDetail(status) {
  const sec = document.getElementById("detailSection");
  const nameEl = document.getElementById("detailRoomName");
  const content = document.getElementById("detailContent");

  if (!status) { sec.style.display = "none"; return; }
  sec.style.display = "block";
  nameEl.textContent = status.community;

  if (!status.peers.length) {
    content.innerHTML = `<p class="empty">房间中没有 Peer</p>`;
    return;
  }

  const rows = status.peers.map((p) => {
    const codeBadge = `<span style="display:inline-block;min-width:24px;padding:2px 6px;background:#334155;color:#e2e8f0;border-radius:4px;font-weight:700;text-align:center">${esc(p.code)}</span>`;

    const ipDisplay = p.online
      ? `<span class="mono">${esc(p.virtualIp)}</span>`
      : `<span style="color:#64748b">--</span>`;

    const statusBadge = p.online
      ? `<span class="badge online">🟢 在线</span> <span style="color:#94a3b8;font-size:12px">${fmtDur(p.onlineFor)}</span>`
      : `<span class="badge unknown">⚪ 离线</span> <span style="color:#94a3b8;font-size:12px">${fmtDur(p.offlineFor)}</span>`;

    const connStr = p.online
      ? formatConnStatus(p.connections)
      : `<span style="color:#64748b">--</span>`;

    const flowStr = p.relayBytesTotal > 0
      ? `${fmtBytes(p.relayBytesTotal)}
         <div style="color:#64748b;font-size:11px">↑${fmtBytes(p.relayBytesOut)} ↓${fmtBytes(p.relayBytesIn)}</div>`
      : `<span style="color:#64748b">0 B</span>`;

    return `
      <tr style="${p.online ? "" : "opacity:0.6"}">
        <td>${codeBadge}</td>
        <td>${ipDisplay}</td>
        <td>${statusBadge}</td>
        <td>${natBadge(p.natType)}</td>
        <td>${connStr}</td>
        <td class="bytes">${flowStr}</td>
        <td style="color:#94a3b8;font-size:12px">${fmtDur(p.idleFor)} 前活跃</td>
      </tr>
    `;
  }).join("");

  content.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>代号</th>
          <th>虚拟 IP</th>
          <th>在线状态</th>
          <th>NAT 类型</th>
          <th>状态</th>
          <th>中继流量</th>
          <th>最后活跃</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:12px;color:#64748b;font-size:12px">
      代号按设备首次上线时间分配。完整信息（设备名、Client ID、公网地址、踢人/清空）请访问
      <a href="/admin" style="color:#60a5fa">管理面板</a>。
    </p>
  `;
}

async function refreshAll() {
  state.rooms = await fetchRooms();
  renderRooms(state.rooms);
  if (state.selectedRoom) await refreshDetail();
  document.getElementById("lastUpdate").textContent =
    `最后更新：${new Date().toLocaleTimeString()}`;
}

async function refreshDetail() {
  if (!state.selectedRoom) return;
  const status = await fetchRoomStatus(state.selectedRoom);
  renderDetail(status);
}

document.getElementById("refreshBtn").addEventListener("click", refreshAll);
refreshAll();
setInterval(refreshAll, 5000);
