// Web 표준 진입점(스펙 §9.3) — (Request) => Promise<Response>. Next · Hono · Workers 같은 곳에 SSE(GET)와 POST 만 붙인다
// 웹소켓은 Web 표준에 없으므로 받지 않는다. 겉의 약속은 node.ts 와 같다
import { CLOSE, type ServerMessage } from "../stream/protocol.js";
import type { Conn, StreamServer } from "./core.js";
import { sseFrame } from "./sse.js";

/** POST 본문의 위 끝 — node.ts 와 같은 1 MiB, 넘으면 413 */
const BODY_MAX = 1 << 20;

/** 요청 헤더를 홉의 꼴로 — Headers 는 이미 소문자 이름이고 여러 값은 쉼표로 이어 준다 */
const headersOf = (req: Request) => {
  const out: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => (out[k] = v));
  return out;
};

const text = (status: number, body?: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** 본문을 글자로 — 위 끝을 넘으면 읽기를 그만두고 undefined */
async function readBody(req: Request): Promise<string | undefined> {
  if (Number(req.headers.get("content-length")) > BODY_MAX) return undefined;
  const dec = new TextDecoder();
  let out = "";
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BODY_MAX) return void (await reader.cancel());
      out += dec.decode(value, { stream: true });
    }
  }
  return out + dec.decode();
}

/** 홉 하나를 Web 표준 처리기로 — GET(Accept text/event-stream)은 SSE, POST 는 command · ask · answer
 *  - SSE 의 첫 send 나 close 가 올 때까지 응답을 돌려주지 않는다 — Response 의 상태는 돌려줄 때 정해지므로,
 *    첫 send 전의 close 는 401(4001) 또는 503(그 밖)로 답한다. 기다림은 홉의 hello · 인증 흐름이 끊는다 */
export function streamHandler(stream: StreamServer<any, any, any>): (req: Request) => Promise<Response> {
  const sse = (req: Request) =>
    new Promise<Response>((respond) => {
      const enc = new TextEncoder();
      const listeners: Array<() => void> = [];
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      let started = false;
      let ended = false;
      const end = () => {
        ended = true;
        for (const fn of listeners) fn();
      };
      // 상대가 끊었다 — 본문 읽기를 그만두거나 요청이 abort 된다
      const gone = () => {
        if (ended) return;
        end();
        // 응답을 아직 돌려주지 않았으면 매달린 약속을 풀어 준다
        if (!started) respond(text(499));
      };
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c), cancel: gone });
      const conn: Conn = {
        kind: "sse",
        headers: headersOf(req),
        send(m: ServerMessage) {
          if (ended) return;
          if (!started) {
            started = true;
            respond(
              new Response(body, {
                headers: {
                  "content-type": "text/event-stream; charset=utf-8",
                  // 프록시(nginx 등)가 쌓아 두거나 고치지 않고 곧바로 흘리게
                  // ponytail: connection: keep-alive 는 HTTP/2 · Workers 에서 금지라 쓰지 않는다
                  "cache-control": "no-cache, no-transform",
                  "x-accel-buffering": "no",
                },
              }),
            );
          }
          ctl.enqueue(enc.encode(sseFrame(m)));
        },
        close(code: number, reason: string) {
          if (ended) return;
          if (!started) respond(text(code === CLOSE.GO_AWAY ? 401 : 503, reason));
          else {
            ctl.enqueue(enc.encode(sseFrame({ t: "close", code, reason })));
            ctl.close();
          }
          end();
        },
        onMessage() {}, // SSE 는 받는 줄이 없다 — command · ask · answer 는 POST 로 온다
        onClose: (fn) => void listeners.push(fn),
      };
      if (req.signal.aborted) return gone();
      req.signal.addEventListener("abort", gone, { once: true });
      stream.attach(conn);
    });

  const post = async (req: Request) => {
    const raw = await readBody(req);
    if (raw === undefined) return text(413);
    let out: { status: number; body: unknown };
    try {
      out = await stream.handlePost({ headers: headersOf(req), body: raw });
    } catch (e) {
      out = { status: 500, body: e instanceof Error ? e.message : String(e) };
    }
    // command 는 reply, ask 는 fate 의 배열(JSON), answer 는 204, 실패는 글자(연결의 약속 5)
    if (out.status === 204) return new Response(null, { status: 204 });
    if (out.status === 200) return Response.json(out.body);
    return text(out.status, String(out.body));
  };

  return async (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket")
      return text(426, 'Web 표준 처리기는 SSE 만 받는다 — transport: "sse" 를 쓴다');
    if (req.method === "GET" && req.headers.get("accept")?.includes("text/event-stream")) return sse(req);
    if (req.method === "POST") return post(req);
    return text(404);
  };
}
