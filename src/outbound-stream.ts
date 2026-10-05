// Workers 出口代理：TCP 流式转发
// 复用 VLESS Worker 的 fetcher.connect 模式

const HANDSHAKE_LEN = 7;
const CONNECT_TIMEOUT = 3000;
const TIMEOUT_MARK = Symbol("timeout");

function withTimeout<T>(promise: Promise<T>, ms: number, mark: symbol): Promise<T | typeof mark> {
  let timer: any;
  const timeout = new Promise<typeof mark>((res) => { timer = setTimeout(() => res(mark), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T | typeof mark>;
}

export async function handleOutboundStream(request: Request, fetcher: any): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

  const connectFn = fetcher.connect.bind(fetcher);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  (server as any).accept();

  let tcpSocket: any = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let handshakeDone = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try { writer?.close(); } catch {}
    try { tcpSocket?.close(); } catch {}
    try { server.close(); } catch {}
  };

  server.addEventListener("message", async (e: MessageEvent) => {
    try {
      let buf: Uint8Array;
      if (e.data instanceof ArrayBuffer) buf = new Uint8Array(e.data);
      else if (e.data instanceof Uint8Array) buf = e.data;
      else if (e.data && (e.data as any).buffer) {
        const v = e.data as ArrayBufferView;
        buf = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      } else return;

      if (!handshakeDone) {
        if (buf.length < HANDSHAKE_LEN) { close(); return; }
        const protocol = buf[0];
        if (protocol !== 0x01) { close(); return; }
        const ip = `${buf[1]}.${buf[2]}.${buf[3]}.${buf[4]}`;
        const port = (buf[5] << 8) | buf[6];
        handshakeDone = true;

        console.log(`[out-stream] TCP connect ${ip}:${port}`);

        try {
          const connPromise = (async () => {
            const s = connectFn({ hostname: ip, port, timeout: CONNECT_TIMEOUT });
            await s.opened;
            return s;
          })();
          const result = await withTimeout(connPromise, CONNECT_TIMEOUT + 500, TIMEOUT_MARK);
          if (result === TIMEOUT_MARK) {
            try { server.send(JSON.stringify({ type: "error", error: "connect timeout" })); } catch {}
            close();
            return;
          }
          tcpSocket = result;
          writer = tcpSocket.writable.getWriter();

          const reader = tcpSocket.readable.getReader();
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.length > 0) {
                  try { server.send(value); } catch {}
                }
              }
            } catch (err) {
              console.warn(`[out-stream] read: ${(err as Error).message}`);
            } finally { close(); }
          })();
        } catch (err) {
          try { server.send(JSON.stringify({ type: "error", error: (err as Error).message })); } catch {}
          close();
          return;
        }

        const payload = buf.slice(HANDSHAKE_LEN);
        if (payload.length > 0 && writer) {
          try { await writer.write(payload); } catch {}
        }
        return;
      }

      if (writer) {
        try { await writer.write(buf); } catch (err) {
          console.warn(`[out-stream] write: ${(err as Error).message}`);
          close();
        }
      }
    } catch (err) {
      console.error(`[out-stream] message handler:`, err);
      close();
    }
  });

  server.addEventListener("close", () => close());
  server.addEventListener("error", () => close());

  return new Response(null, { status: 101, webSocket: client });
}
