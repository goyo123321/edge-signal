export { Room } from "./room";
export { Registry } from "./registry";

export interface Env {
  ROOM: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  CONNECT_TOKEN?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_SERVERS?: string;
  TURN_USERNAME?: string;
  TURN_PASSWORD?: string;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ★ 修复：未配置 ADMIN_TOKEN 时返回 null，强制管理员必须配置
function getAdminToken(env: Env): string | null {
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.trim() !== "") {
    return env.ADMIN_TOKEN;
  }
  return null;
}

function checkAdmin(request: Request, env: Env): boolean {
  const expected = getAdminToken(env);
  if (!expected) return false; // ★ 修复：未配置就拒绝
  const url = new URL(request.url);
  const provided =
    url.searchParams.get("token") ||
    request.headers.get("X-Admin-Token") ||
    "";
  return safeEqual(provided, expected);
}

function jsonResp(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ============ TURN 配置检查 ============

function hasCloudflareTURN(env: Env): boolean {
  return !!(
    env.TURN_KEY_ID &&
    env.TURN_KEY_ID.trim() !== "" &&
    env.TURN_KEY_API_TOKEN &&
    env.TURN_KEY_API_TOKEN.trim() !== ""
  );
}

function hasCustomTURN(env: Env): boolean {
  return !!(env.TURN_SERVERS && env.TURN_SERVERS.trim() !== "");
}

function isTURNEnabled(env: Env): boolean {
  return hasCloudflareTURN(env) || hasCustomTURN(env);
}

// ============ TURN URL 解析 ============

function parseTURNUrl(
  raw: string,
  defaultUsername: string,
  defaultPassword: string
): { url: string; username: string; password: string } | null {
  let s = raw.trim();
  if (!s) return null;

  let scheme = "turn";
  if (s.startsWith("turns://")) {
    scheme = "turns";
    s = s.slice("turns://".length);
  } else if (s.startsWith("turn://")) {
    scheme = "turn";
    s = s.slice("turn://".length);
  } else if (s.startsWith("turns:")) {
    scheme = "turns";
    s = s.slice("turns:".length);
  } else if (s.startsWith("turn:")) {
    scheme = "turn";
    s = s.slice("turn:".length);
  }

  if (s.startsWith("//")) {
    s = s.slice(2);
  }

  let username = defaultUsername;
  let password = defaultPassword;
  const atIdx = s.lastIndexOf("@");
  if (atIdx >= 0) {
    const userInfo = s.slice(0, atIdx);
    s = s.slice(atIdx + 1);

    const colonIdx = userInfo.indexOf(":");
    if (colonIdx >= 0) {
      try {
        username = decodeURIComponent(userInfo.slice(0, colonIdx));
        password = decodeURIComponent(userInfo.slice(colonIdx + 1));
      } catch {
        username = userInfo.slice(0, colonIdx);
        password = userInfo.slice(colonIdx + 1);
      }
    } else {
      username = userInfo;
      password = defaultPassword;
    }
  }

  if (!s) return null;
  if (!s.includes(":")) {
    s = s + ":3478";
  }

  return {
    url: `${scheme}:${s}`,
    username,
    password,
  };
}

function generateCustomTURN(
  env: Env,
  ttl: number
): Array<{ url: string; username: string; password: string; ttl: number }> {
  const serversStr = env.TURN_SERVERS || "";
  const defaultUsername = env.TURN_USERNAME || "";
  const defaultPassword = env.TURN_PASSWORD || "";

  const servers: Array<{ url: string; username: string; password: string; ttl: number }> = [];

  for (const raw of serversStr.split(",")) {
    const parsed = parseTURNUrl(raw, defaultUsername, defaultPassword);
    if (!parsed) continue;
    servers.push({
      url: parsed.url,
      username: parsed.username,
      password: parsed.password,
      ttl,
    });
  }

  return servers;
}

async function generateCloudflareTURN(
  env: Env,
  ttl: number
): Promise<Array<{ url: string; username: string; password: string; ttl: number }>> {
  const apiUrl = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`;
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TURN_KEY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl }),
  });

  if (!resp.ok) {
    console.error("[TURN] Cloudflare API failed:", resp.status, await resp.text());
    return [];
  }

  const data: any = await resp.json();
  const servers: Array<{ url: string; username: string; password: string; ttl: number }> = [];

  for (const ice of data.iceServers || []) {
    for (const u of ice.urls || []) {
      if (u.startsWith("turn:") || u.startsWith("turns:")) {
        servers.push({
          url: u,
          username: ice.username,
          password: ice.credential,
          ttl,
        });
      }
    }
  }

  return servers;
}

// ============ 主入口 ============

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 公开面板
    if (pathname === "/" || pathname === "/index.html") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }

    // 管理面板
    if (pathname === "/admin" || pathname === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url)));
    }

    // ========== TURN 凭证端点 ==========
    if (pathname === "/api/turn-credentials") {
      // 如果配了 CONNECT_TOKEN，强制校验
      if (env.CONNECT_TOKEN && env.CONNECT_TOKEN.trim() !== "") {
        const provided = url.searchParams.get("token") || "";
        if (!safeEqual(provided, env.CONNECT_TOKEN)) {
          return jsonResp(
            {
              success: false,
              error: "Unauthorized",
              servers: [],
            },
            401
          );
        }
      }

      if (!isTURNEnabled(env)) {
        return jsonResp({
          success: false,
          error: "TURN not configured",
          servers: [],
        });
      }

      const ttl = parseInt(url.searchParams.get("ttl") || "86400");

      try {
        let servers: Array<{ url: string; username: string; password: string; ttl: number }> = [];
        let source = "";

        if (hasCloudflareTURN(env)) {
          servers = await generateCloudflareTURN(env, ttl);
          source = "cloudflare";
          if (servers.length === 0) {
            console.warn("[TURN] Cloudflare TURN 返回空，尝试自定义 TURN");
          }
        }

        if (servers.length === 0 && hasCustomTURN(env)) {
          servers = generateCustomTURN(env, ttl);
          source = "custom";
        }

        if (servers.length === 0) {
          return jsonResp({
            success: false,
            error: "No TURN servers available",
            servers: [],
          });
        }

        const logServers = servers.map((s) => ({
          url: s.url,
          username: s.username || "(无)",
          password: s.password ? "***" : "(无)",
        }));
        console.log(`[TURN] 返回 ${servers.length} 个 ${source} 服务器:`, JSON.stringify(logServers));

        return jsonResp({
          success: true,
          source,
          servers,
        });
      } catch (e) {
        console.error("[TURN] error:", e);
        return jsonResp({
          success: false,
          error: "TURN error",
          servers: [],
        });
      }
    }

    // ========== 公开 API ==========
    if (pathname === "/api/public/rooms") {
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      return reg.fetch(new Request("http://internal/rooms"));
    }

    // ★ 修复：用 slice 替代 split("/")[4]，防止多段路径截断
    if (pathname.startsWith("/api/public/status/")) {
      const roomId = decodeURIComponent(
        pathname.slice("/api/public/status/".length)
      );
      if (!roomId) return jsonResp({ error: "Missing roomId" }, 400);
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(
        new Request(
          `http://internal/_status?public=1&community=${encodeURIComponent(roomId)}`
        )
      );
    }

    // ========== 管理员 API ==========
    const isAdminRoute =
      pathname.startsWith("/api/admin/") ||
      pathname === "/api/rooms" ||
      pathname.startsWith("/api/status/") ||
      pathname.startsWith("/api/nathole/");

    if (isAdminRoute) {
      if (!checkAdmin(request, env)) {
        return jsonResp({ error: "Unauthorized" }, 401);
      }

      if (pathname === "/api/admin/rooms" || pathname === "/api/rooms") {
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
        return reg.fetch(new Request("http://internal/rooms"));
      }

      const statusMatch = pathname.match(/^\/api\/(admin\/)?status\/(.+)$/);
      if (statusMatch) {
        const roomId = decodeURIComponent(statusMatch[2]);
        const id = env.ROOM.idFromName(roomId);
        return env.ROOM.get(id).fetch(
          new Request(
            `http://internal/_status?community=${encodeURIComponent(roomId)}`
          )
        );
      }

      const natholeMatch = pathname.match(/^\/api\/(admin\/)?nathole\/(.+)$/);
      if (natholeMatch) {
        const roomId = decodeURIComponent(natholeMatch[2]);
        const id = env.ROOM.idFromName(roomId);
        return env.ROOM.get(id).fetch(
          new Request(
            `http://internal/_nathole?community=${encodeURIComponent(roomId)}`
          )
        );
      }

      if (pathname === "/api/admin/clear" && request.method === "POST") {
        const room = url.searchParams.get("room");
        const force = url.searchParams.get("force") === "1";
        if (!room) return jsonResp({ error: "Missing room" }, 400);

        let clearResp: Response;
        try {
          const id = env.ROOM.idFromName(room);
          const clearUrl = force
            ? "http://internal/_clear?force=1"
            : "http://internal/_clear";
          clearResp = await env.ROOM.get(id).fetch(new Request(clearUrl));
        } catch (e) {
          console.error(`[admin] clear room DO ${room} failed:`, e);
          return jsonResp({ error: "Failed to clear room" }, 500);
        }

        if (clearResp.status === 409) {
          const body: any = await clearResp.json().catch(() => ({}));
          return jsonResp(
            {
              error: "Room has online peers",
              room,
              onlineCount: body.onlineCount || 0,
              onlinePeers: body.onlinePeers || [],
            },
            409
          );
        }

        if (!clearResp.ok) {
          return jsonResp({ error: "Clear failed" }, 500);
        }

        try {
          const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
          await reg.fetch(
            new Request(
              `http://internal/_clear-one?room=${encodeURIComponent(room)}`,
              { method: "POST" }
            )
          );
        } catch (e) {
          console.error(`[admin] clear registry ${room} failed:`, e);
        }

        return jsonResp({ ok: true, room });
      }

      if (pathname === "/api/admin/kick" && request.method === "POST") {
        const room = url.searchParams.get("room");
        const cid = url.searchParams.get("cid");
        if (!room || !cid)
          return jsonResp({ error: "Missing room or cid" }, 400);

        const id = env.ROOM.idFromName(room);
        return env.ROOM.get(id).fetch(
          new Request(
            `http://internal/_kick?cid=${encodeURIComponent(cid)}`,
            { method: "POST" }
          )
        );
      }

      if (pathname === "/api/admin/clear-all" && request.method === "POST") {
        const force = url.searchParams.get("force") === "1";

        let rooms: any[] = [];
        try {
          const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
          const resp = await reg.fetch(new Request("http://internal/rooms"));
          rooms = await resp.json();
        } catch (e) {
          console.error("[admin] list rooms failed:", e);
        }

        const cleared: string[] = [];
        const skipped: any[] = [];
        const failed: string[] = [];

        for (const r of rooms) {
          try {
            const id = env.ROOM.idFromName(r.name);
            const clearUrl = force
              ? "http://internal/_clear?force=1"
              : "http://internal/_clear";
            const resp = await env.ROOM.get(id).fetch(new Request(clearUrl));

            if (resp.ok) {
              cleared.push(r.name);
            } else if (resp.status === 409) {
              const body: any = await resp.json().catch(() => ({}));
              skipped.push({
                room: r.name,
                reason: "has online peers",
                onlineCount: body.onlineCount || 0,
              });
            } else {
              failed.push(r.name);
            }
          } catch (e) {
            console.error(`[admin] clear room ${r.name} failed:`, e);
            failed.push(r.name);
          }
        }

        for (const name of cleared) {
          try {
            const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
            await reg.fetch(
              new Request(
                `http://internal/_clear-one?room=${encodeURIComponent(name)}`,
                { method: "POST" }
              )
            );
          } catch (e) {
            console.error(`[admin] clear registry ${name} failed:`, e);
          }
        }

        return jsonResp({
          ok: true,
          cleared,
          skipped,
          failed,
          count: cleared.length,
          skippedCount: skipped.length,
          failedCount: failed.length,
        });
      }

      return new Response("Not found", { status: 404 });
    }

    // ========== WebSocket 信令 ==========
    if (pathname.startsWith("/ws/")) {
      if (env.CONNECT_TOKEN && env.CONNECT_TOKEN.trim() !== "") {
        const provided = url.searchParams.get("token") || "";
        if (!safeEqual(provided, env.CONNECT_TOKEN)) {
          return new Response("Invalid token", { status: 403 });
        }
      }

      const roomId = pathname.split("/")[2];
      if (!roomId) return jsonResp({ error: "Missing roomId" }, 400);
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
