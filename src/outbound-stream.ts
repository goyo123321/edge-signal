const DEFAULT_TURN_URL = 'turn://test:test@111.171.194.230:3478';
const DEFAULT_UUID = '2523c510-9ff0-415b-9582-93949bfae7e3';

const MUX_OPEN  = 0x01;
const MUX_DATA  = 0x02;
const MUX_CLOSE = 0x03;
const MUX_FAIL  = 0x04;

export async function handleOutboundStream(
  request: Request,
  fetcher: any,
  env: any
): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  // UUID 校验用
  const uuidStr = env?.UUID || DEFAULT_UUID;
  const uuidBytes = parseUUID(uuidStr);
  if (!uuidBytes) {
    return new Response("Server UUID invalid", { status: 500 });
  }

  // TURN 配置
  const turn =
    getTurn(request.url) ||
    getTurn(env?.TURN_URL) ||
    getTurn(DEFAULT_TURN_URL);

  const connectFn = fetcher.connect.bind(fetcher);

  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();

  let authenticated = false;
  let closed = false;
  const streams = new Map<number, { tcp: any; writer: WritableStreamDefaultWriter<Uint8Array> }>();

  const send = (d: Uint8Array) => {
    if (closed) return;
    try { server.send(d); } catch {}
  };

  const sendFrame = (type: number, id: number, payload: Uint8Array | null) => {
    const p = payload ?? new Uint8Array(0);
    const buf = new Uint8Array(5 + p.length);
    buf[0] = (id >> 8) & 0xff;
    buf[1] = id & 0xff;
    buf[2] = type;
    buf[3] = (p.length >> 8) & 0xff;
    buf[4] = p.length & 0xff;
    buf.set(p, 5);
    send(buf);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const [id, s] of streams) {
      try { s.writer?.releaseLock(); } catch {}
      try { s.tcp?.close?.(); } catch {}
    }
    streams.clear();
    safeClose(server);
  };

  const closeStream = async (id: number) => {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    try { s.writer?.releaseLock(); } catch {}
    try { s.tcp?.close?.(); } catch {}
  };

  const openStream = async (id: number, ip: string, port: number) => {
    let tcp: any = null;
    try {
      tcp = connectFn({ hostname: ip, port });
      await tcp.opened;
    } catch (e) {
      // TURN 回退
      if (turn) {
        try { tcp = await turnConn(turn, ip, port, connectFn); } catch {}
      }
    }

    if (!tcp) {
      console.log(`[Mux] open ${id} → ${ip}:${port} failed`);
      sendFrame(MUX_FAIL, id, enc('connect failed'));
      return;
    }

    console.log(`[Mux] open ${id} → ${ip}:${port} ok`);
    const writer = tcp.writable.getWriter();
    streams.set(id, { tcp, writer });

    (async () => {
      try {
        const reader = tcp.readable.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            sendFrame(MUX_DATA, id, new Uint8Array(value));
          }
        }
      } catch (e) {
        console.error(`[Mux] stream ${id} read error:`, e);
      } finally {
        sendFrame(MUX_CLOSE, id);
        await closeStream(id);
      }
    })();
  };

  const processFrame = async (data: Uint8Array) => {
    if (data.length < 5) return;
    const id = (data[0] << 8) | data[1];
    const type = data[2];
    const length = (data[3] << 8) | data[4];
    if (data.length < 5 + length) return;
    const payload = data.subarray(5, 5 + length);

    if (type === MUX_OPEN) {
      if (payload.length < 6) {
        sendFrame(MUX_FAIL, id, enc('invalid open payload'));
        return;
      }
      const ip = `${payload[0]}.${payload[1]}.${payload[2]}.${payload[3]}`;
      const port = (payload[4] << 8) | payload[5];
      await openStream(id, ip, port);
    } else if (type === MUX_DATA) {
      const s = streams.get(id);
      if (s?.writer) {
        try { await s.writer.write(payload); } catch (e) {
          console.error(`[Mux] stream ${id} write error:`, e);
          await closeStream(id);
        }
      }
    } else if (type === MUX_CLOSE) {
      await closeStream(id);
    }
  };

  const processAuth = (data: Uint8Array): boolean => {
    if (data.length < 19) return false;
    if (!bytesEqual(data.subarray(0, 16), uuidBytes)) return false;
    const jsonLen = (data[17] << 8) | data[18];
    if (data.length < 19 + jsonLen) return false;
    try {
      const meta = JSON.parse(dec.decode(data.subarray(19, 19 + jsonLen)));
      console.log(`[Mux] auth OK: ${JSON.stringify(meta)}`);
    } catch {
      console.log(`[Mux] auth OK (meta parse failed)`);
    }
    return true;
  };

  server.addEventListener("message", async (e: MessageEvent) => {
    let data: Uint8Array;
    if (e.data instanceof ArrayBuffer) data = new Uint8Array(e.data);
    else if (e.data instanceof Uint8Array) data = e.data;
    else if ((e.data as any)?.buffer) data = new Uint8Array((e.data as any).buffer);
    else return;

    if (!authenticated) {
      if (processAuth(data)) {
        authenticated = true;
        send(new Uint8Array([0x00, 0x01]));
      } else {
        console.warn('[Mux] UUID mismatch');
        send(new Uint8Array([0x01, 0x01]));
        close();
      }
      return;
    }

    try { await processFrame(data); } catch (e) {
      console.error('[Mux] processFrame error:', e);
    }
  });

  server.addEventListener("close", close);
  server.addEventListener("error", close);

  return new Response(null, { status: 101, webSocket: client });
}

// ============================================================
// 工具函数
// ============================================================

const dec = new TextDecoder();
const enc = (s: string) => new TextEncoder().encode(s);
const u16 = (b: Uint8Array, o = 0) => (b[o] << 8) | b[o + 1];
const pad4 = (n: number) => -n & 3;

const cat = (...a: Uint8Array[]) => {
  const r = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of a) { r.set(x, o); o += x.length; }
  return r;
};

const safeClose = (...a: any[]) => a.forEach(x => { try { x?.close?.(); } catch {} });

function parseUUID(s: string): Uint8Array | null {
  const hex = s.replace(/-/g, '');
  if (hex.length !== 32) return null;
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ============================================================
// STUN / TURN
// ============================================================

const MAGIC = new Uint8Array([0x21, 0x12, 0xA4, 0x42]);

const MT = {
  AQ: 0x003, AO: 0x103, AE: 0x113,
  PQ: 0x008, PO: 0x108,
  CQ: 0x00A, CO: 0x10A,
  BQ: 0x00B, BO: 0x10B,
};

const AT = {
  USER: 0x006, MI: 0x008, ERR: 0x009,
  PEER: 0x012, DATA: 0x013, REALM: 0x014, NONCE: 0x015,
  XOR_RELAYED: 0x016,
  TRANSPORT: 0x019, CONNID: 0x02A,
};

const tid = () => crypto.getRandomValues(new Uint8Array(12));

const stunAttr = (t: number, v: Uint8Array): Uint8Array => {
  const b = new Uint8Array(4 + v.length + pad4(v.length));
  const d = new DataView(b.buffer);
  d.setUint16(0, t);
  d.setUint16(2, v.length);
  b.set(v, 4);
  return b;
};

const stunMsg = (t: number, id: Uint8Array, a: Uint8Array[]): Uint8Array => {
  const bd = cat(...a);
  const h = new Uint8Array(20);
  const d = new DataView(h.buffer);
  d.setUint16(0, t);
  d.setUint16(2, bd.length);
  h.set(MAGIC, 4);
  h.set(id, 8);
  return cat(h, bd);
};

const xorPeer = (ip: string, port: number): Uint8Array => {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (!clean.includes(':')) {
    const b = new Uint8Array(8);
    b[1] = 1;
    const d = new DataView(b.buffer);
    d.setUint16(2, port ^ 0x2112);
    const parts = clean.split('.');
    for (let i = 0; i < 4; i++) b[4 + i] = (+parts[i] || 0) ^ MAGIC[i];
    return b;
  }
  return new Uint8Array(8); // 本项目暂不支持 IPv6
};

const parseStun = (d: Uint8Array): any => {
  if (d.length < 20 || MAGIC.some((v, i) => d[4 + i] !== v)) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const ml = dv.getUint16(2);
  const attrs: Record<number, Uint8Array> = {};
  const end = Math.min(d.length, 20 + ml);
  for (let o = 20; o + 4 <= end; ) {
    const t = dv.getUint16(o);
    const l = dv.getUint16(o + 2);
    if (o + 4 + l > end) break;
    attrs[t] = d.slice(o + 4, o + 4 + l);
    o += 4 + l + pad4(l);
  }
  return { type: dv.getUint16(0), attrs };
};

const parseErr = (d?: Uint8Array) => (d && d.length >= 4) ? (d[2] & 7) * 100 + d[3] : 0;

const parseXorPeer = (d?: Uint8Array): [string, number] => {
  if (!d || d.length < 4) return ['', 0];
  const family = d[1];
  const port = u16(d, 2) ^ 0x2112;
  if (family === 1) {
    if (d.length < 8) return ['', 0];
    const ip: number[] = [];
    for (let i = 0; i < 4; i++) ip.push(d[4 + i] ^ MAGIC[i]);
    return [ip.join('.'), port];
  }
  return ['', 0];
};

const addIntegrity = async (m: Uint8Array, key: Uint8Array): Promise<Uint8Array> => {
  const c = new Uint8Array(m);
  const d = new DataView(c.buffer);
  d.setUint16(2, d.getUint16(2) + 24);
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return cat(c, stunAttr(AT.MI, new Uint8Array(await crypto.subtle.sign('HMAC', k, c))));
};

const readStun = async (rd: ReadableStreamDefaultReader<Uint8Array>, buf?: Uint8Array | null): Promise<[any, Uint8Array | null]> => {
  let b = buf ?? new Uint8Array(0);
  const pull = async () => {
    const { done, value } = await rd.read();
    if (done) throw 0;
    b = cat(b, new Uint8Array(value!));
  };
  try {
    while (b.length < 20) await pull();
    const n = 20 + u16(b, 2);
    while (b.length < n) await pull();
    return [parseStun(b.subarray(0, n)), b.length > n ? b.subarray(n) : null];
  } catch {
    return [null, null];
  }
};

const md5 = async (s: string) => new Uint8Array(await crypto.subtle.digest('MD5', enc(s)));

const getTurn = (url: string): { host: string; port: number; user: string; pass: string } | null => {
  if (!url) return null;
  try {
    let raw = decodeURIComponent(url);
    const match = raw.match(/(?:\/)?turn:\/\/([^?&#\s]*)/i);
    if (!match) return null;
    const t = match[1];
    const at = t.lastIndexOf('@');
    const cred = at >= 0 ? t.slice(0, at) : '';
    const hp = at >= 0 ? t.slice(at + 1) : t;

    let host = '', p = '';
    if (hp.startsWith('[')) {
      const x = hp.indexOf(']');
      if (x < 0) return null;
      host = hp.slice(1, x);
      p = hp.slice(x + 1).replace(/^:/, '');
    } else {
      const x = hp.lastIndexOf(':');
      if (x < 0) return null;
      host = hp.slice(0, x);
      p = hp.slice(x + 1);
    }
    const ci = cred.indexOf(':');
    return {
      host,
      port: +p || 3478,
      user: ci >= 0 ? cred.slice(0, ci) : '',
      pass: ci >= 0 ? cred.slice(ci + 1) : '',
    };
  } catch { return null; }
};

// ============================================================
// TURN TCP (RFC 6062)
// ============================================================

const turnConn = async (
  turn: { host: string; port: number; user: string; pass: string },
  targetIp: string,
  targetPort: number,
  connectFn: any,
): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close: () => void } | null> => {
  const { host, port, user, pass } = turn;
  let ctrl: any = null;
  let data: any = null;
  const close = () => safeClose(ctrl, data);

  try {
    // 1. control 连接 3478
    ctrl = connectFn({ hostname: host, port });
    await ctrl.opened;
    const cw = ctrl.writable.getWriter();
    const cr = ctrl.readable.getReader();

    // 2. Allocate(TCP)
    const tp = new Uint8Array([6, 0, 0, 0]);
    await cw.write(stunMsg(MT.AQ, tid(), [stunAttr(AT.TRANSPORT, tp)]));

    let [msg, ex] = await readStun(cr);
    if (!msg) { close(); return null; }

    let key: Uint8Array | null = null;
    let aa: Uint8Array[] = [];
    const sign = (m: Uint8Array) => key ? addIntegrity(m, key) : Promise.resolve(m);

    if (msg.type === MT.AE && user && parseErr(msg.attrs[AT.ERR]) === 401) {
      const realm = dec.decode(msg.attrs[AT.REALM] ?? new Uint8Array(0));
      const nonce = msg.attrs[AT.NONCE] ?? new Uint8Array(0);
      key = await md5(`${user}:${realm}:${pass}`);
      aa = [stunAttr(AT.USER, enc(user)), stunAttr(AT.REALM, enc(realm)), stunAttr(AT.NONCE, nonce)];

      const aq = await addIntegrity(stunMsg(MT.AQ, tid(), [stunAttr(AT.TRANSPORT, tp), ...aa]), key);
      await cw.write(aq);

      [msg, ex] = await readStun(cr, ex);
      if (!msg) { close(); return null; }
    }

    if (msg.type !== MT.AO) { close(); return null; }

    // 3. 从 Allocate 响应提取 relay 地址
    const relayData = msg.attrs[AT.XOR_RELAYED];
    if (!relayData) { close(); return null; }
    const [relayIP, relayPort] = parseXorPeer(relayData);
    if (!relayIP || !relayPort) { close(); return null; }
    console.log(`[TURN] relay=${relayIP}:${relayPort}`);

    // 4. Connect + CreatePermission
    const peer = stunAttr(AT.PEER, xorPeer(targetIp, targetPort));
    const connMsg = await sign(stunMsg(MT.CQ, tid(), [peer, ...aa]));
    const permMsg = await sign(stunMsg(MT.PQ, tid(), [peer, ...aa]));
    await cw.write(cat(connMsg, permMsg));

    let r: any;
    [r, ex] = await readStun(cr, ex);
    if (r?.type !== MT.CO || !r.attrs[AT.CONNID]) { close(); return null; }
    const connID = r.attrs[AT.CONNID];

    [r, ex] = await readStun(cr, ex);
    if (r?.type !== MT.PO) { close(); return null; }

    // 5. data 连接 relay 地址
    data = connectFn({ hostname: relayIP, port: relayPort });
    await data.opened;

    const dw = data.writable.getWriter();
    const dr = data.readable.getReader();

    // 6. ConnectionBind
    await dw.write(await sign(stunMsg(MT.BQ, tid(), [stunAttr(AT.CONNID, connID), ...aa])));

    let extra: Uint8Array | null = null;
    [r, extra] = await readStun(dr);
    if (r?.type !== MT.BO) { close(); return null; }

    cr.releaseLock();
    cw.releaseLock();
    dw.releaseLock();

    const readable = new ReadableStream<Uint8Array>({
      start(c) { if (extra && extra.length) c.enqueue(extra); },
      async pull(c) {
        try {
          const { done, value } = await dr.read();
          if (done) c.close();
          else c.enqueue(new Uint8Array(value!));
        } catch { c.close(); }
      },
      cancel() { try { dr.cancel(); } catch {} },
    });

    return { readable, writable: data.writable, close };
  } catch (e) {
    console.error('[TURN] turnConn error:', e);
    close();
    return null;
  }
};
