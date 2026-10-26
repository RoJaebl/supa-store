// Node http 서버에 붙는 겉(스펙 §9.2) — 한 path 에서 웹소켓(ws) · SSE(GET) · POST 를 받아 홉의 Conn · handlePost 로 맞춘다
// ws 는 선택 peer 라 웹소켓 Upgrade 가 처음 올 때 동적으로 들인다 — 없어도 SSE 와 POST 는 돈다
import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { CLOSE, type ClientMessage, type ServerMessage } from "../stream/protocol.js";
import type { Conn, StreamServer } from "./core.js";
import { sseFrame } from "./sse.js";

/** POST 본문의 위 끝 — 명령 하나가 이보다 크면 413
 *  ponytail: 고정 1 MiB. 큰 인자를 보내는 앱이 생기면 옵션으로 연다 */
const BODY_MAX = 1 << 20;

/** 요청의 헤더를 홉의 꼴로 — 이름은 소문자(연결의 약속 4), 여러 값은 쉼표로 잇는다 */
const headersOf = (req: IncomingMessage) => {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
};

/** 웹소켓의 닫기 이유는 123 바이트까지 — 넘으면 ws 가 던지므로 글자 단위로 자른다 */
const fit = (reason: string) => {
  const enc = new TextEncoder();
  let r = reason;
  while (enc.encode(r).length > 123) r = r.slice(0, -1);
  return r;
};

const DETACHED = "서버가 떼어 낸다";

export function attachStream(server: Server, o: { path: string; stream: StreamServer<any, any, any> }): () => void {
  const { path, stream } = o;
  /** 지금 열린 연결의 닫기 — 떼어 낼 때 모두 부른다 */
  const open = new Set<() => void>();
  const track = (shut: () => void, onGone: (fn: () => void) => void) => {
    open.add(shut);
    onGone(() => open.delete(shut));
  };
  let wss: Promise<WebSocketServer> | undefined;
  let detached = false;

  const ours = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").pathname === path;

  // 붙기 전의 요청 처리기(Express 등)를 걷어 우리 처리기 뒤로 둔다 — 그 path 밖의 요청은 그쪽이 받는다
  // ponytail: 붙인 뒤에 더한 request 리스너는 그 path 의 요청도 함께 받는다. 그런 틀이 생기면 그때 가린다
  const prior = server.listeners("request") as RequestListener[];
  const fallthrough = (req: IncomingMessage, res: ServerResponse) => {
    if (prior.length === 0) return void res.writeHead(404).end();
    for (const fn of prior) fn.call(server, req, res);
  };

  /** GET(Accept text/event-stream) — 요청이 곧 hello. 첫 send 에 응답 머리를 쓴다 */
  const sse = (req: IncomingMessage, res: ServerResponse) => {
    let started = false;
    const close = (code: number, reason: string) => {
      if (res.writableEnded) return;
      // 아직 아무것도 보내지 않았으면 HTTP 상태로 — 4001 은 401, 그 밖은 503(연결의 약속 9)
      if (!started)
        return void res
          .writeHead(code === CLOSE.GO_AWAY ? 401 : 503, { "content-type": "text/plain; charset=utf-8" })
          .end(reason);
      res.end(sseFrame({ t: "close", code, reason }));
    };
    const conn: Conn = {
      kind: "sse",
      headers: headersOf(req),
      send(m: ServerMessage) {
        if (res.writableEnded) return;
        if (!started) {
          started = true;
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        res.write(sseFrame(m));
      },
      close,
      onMessage() {}, // SSE 는 받는 줄이 없다 — command · ask · answer 는 POST 로 온다
      onClose: (fn) => void res.on("close", fn),
    };
    track(() => close(CLOSE.COME_BACK, DETACHED), conn.onClose);
    stream.attach(conn);
  };

  const post = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) {
        res.writeHead(413).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      let out: { status: number; body: unknown };
      try {
        out = await stream.handlePost({ headers: headersOf(req), body: Buffer.concat(chunks).toString("utf8") });
      } catch (e) {
        out = { status: 500, body: e instanceof Error ? e.message : String(e) };
      }
      // command 는 reply, ask 는 fate 의 배열(JSON), answer 는 204, 실패는 글자(연결의 약속 5)
      if (out.status === 204) return void res.writeHead(204).end();
      if (out.status === 200)
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out.body));
      res.writeHead(out.status, { "content-type": "text/plain; charset=utf-8" }).end(String(out.body));
    });
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (!ours(req)) return fallthrough(req, res);
    if (req.method === "GET" && req.headers.accept?.includes("text/event-stream")) return sse(req, res);
    if (req.method === "POST") return post(req, res);
    fallthrough(req, res);
  };

  /** 웹소켓 하나를 Conn 으로 — 메시지는 JSON 글자 하나, 꼴은 홉이 본다 */
  const wsConn = (ws: WebSocket, req: IncomingMessage) => {
    const close = (code: number, reason: string) => ws.close(code, fit(reason));
    const conn: Conn = {
      kind: "ws",
      headers: headersOf(req),
      send: (m) => void (ws.readyState === ws.OPEN && ws.send(JSON.stringify(m))),
      close,
      onMessage: (fn) =>
        void ws.on("message", (data) => {
          let m: ClientMessage;
          try {
            m = JSON.parse(String(data));
          } catch {
            return; // JSON 이 아니면 버린다
          }
          fn(m);
        }),
      onClose: (fn) => void ws.on("close", fn),
    };
    track(() => close(CLOSE.COME_BACK, DETACHED), conn.onClose);
    stream.attach(conn);
  };

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!ours(req)) {
      // 다른 upgrade 리스너가 없으면 아무도 받지 않으므로 끊는다
      if (server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    let ws: WebSocketServer;
    try {
      ws = await (wss ??= import("ws").then((m) => new m.WebSocketServer({ noServer: true })));
    } catch {
      wss = undefined;
      const text = "웹소켓을 받으려면 ws 를 설치한다(pnpm add ws)";
      socket.end(`HTTP/1.1 501 Not Implemented\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n${text}`);
      return;
    }
    if (detached) return void socket.destroy();
    ws.handleUpgrade(req, socket, head, (w) => wsConn(w, req));
  };

  server.removeAllListeners("request");
  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);

  return () => {
    if (detached) return;
    detached = true;
    server.off("request", onRequest);
    server.off("upgrade", onUpgrade);
    for (const fn of prior) server.on("request", fn);
    for (const shut of [...open]) shut();
    open.clear();
  };
}
