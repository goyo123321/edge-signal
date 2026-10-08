import { DurableObject } from "cloudflare:workers";

export class Registry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      const body: any = await request.json();
      const rooms = (await this.ctx.storage.get<Record<string, any>>("rooms")) || {};
      rooms[body.roomName] = {
        lastActive: Date.now(),
        peerCount: body.peerCount || 0,
        onlineCount: body.onlineCount || 0,
        offlineCount: body.offlineCount || 0,
      };
      await this.ctx.storage.put("rooms", rooms);
      return new Response("OK");
    }

    if (url.pathname === "/rooms") {
      const rooms = (await this.ctx.storage.get<Record<string, any>>("rooms")) || {};
      const now = Date.now();
      const active: any[] = [];
      let changed = false;

      for (const [name, info] of Object.entries(rooms)) {
        if (now - (info as any).lastActive > 60 * 60 * 1000) {
          delete rooms[name];
          changed = true;
        } else {
          active.push({ name, ...(info as any) });
        }
      }
      if (changed) await this.ctx.storage.put("rooms", rooms);

      return new Response(JSON.stringify(active), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/_clear-one" && request.method === "POST") {
      const room = url.searchParams.get("room");
      if (!room) {
        return new Response(JSON.stringify({ error: "Missing room" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const rooms = (await this.ctx.storage.get<Record<string, any>>("rooms")) || {};
      const existed = room in rooms;
      delete rooms[room];
      await this.ctx.storage.put("rooms", rooms);
      console.log(`[Registry] cleared room "${room}" (existed=${existed})`);
      return new Response(JSON.stringify({ ok: true, room, existed }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/_clear-all" && request.method === "POST") {
      const rooms = (await this.ctx.storage.get<Record<string, any>>("rooms")) || {};
      const count = Object.keys(rooms).length;
      await this.ctx.storage.deleteAll();
      console.log(`[Registry] cleared ALL rooms (${count} deleted)`);
      return new Response(JSON.stringify({ ok: true, count }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
