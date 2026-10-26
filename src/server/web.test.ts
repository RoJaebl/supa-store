// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { ServerMessage } from "../stream/protocol.js";
import { createStreamServer, type Conn, type StreamServer } from "./core.js";
import { streamHandler } from "./web.js";

const URL_ = "http://x/s";
/** 시험마다 닫을 것 — 열린 본문 읽기가 남으면 vitest 가 끝나지 않는다 */
let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** SSE 요청을 처리기에 직접 넣고, 본문을 빈 줄로 나눠 이벤트로 읽는다 */
async function sseOpen(handler: (req: Request) => Promise<Response>, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const res = await handler(new Request(URL_, { headers: { accept: "text/event-stream", ...headers }, signal: abort.signal }));
  cleanup.push(() => abort.abort());
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: Array<{ id?: string; data: string[]; raw: string }> = [];
  const until = async (n: number) => {
    while (events.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const lines = raw.split("\n");
        events.push({
          id: lines.find((l) => l.startsWith("id: "))?.slice(4),
          data: lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)),
          raw,
        });
      }
    }
    return events.slice(0, n);
  };
  const messages = async (n: number) => (await until(n)).map((e) => JSON.parse(e.data[0]!) as ServerMessage);
  return { res, reader, until, messages, abort: () => abort.abort() };
}

const post = (h: (req: Request) => Promise<Response>, headers: Record<string, string>, body: unknown) =>
  h(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

it("web: GET 은 SSE 응답이고 welcome · snapshot · change 가 흐른다", async () => {
  const stream = createStreamServer({ snapshot: () => "line1\nline2" });
  cleanup.push(() => stream.close());
  const c = await sseOpen(streamHandler(stream));
  expect(c.res.status).toBe(200);
  expect(c.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  expect(c.res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(c.res.headers.get("x-accel-buffering")).toBe("no");
  const [welcome, snapshot] = await c.until(2);
  expect(welcome!.id).toBeUndefined();
  expect(JSON.parse(welcome!.data[0]!)).toMatchObject({ t: "welcome", version: 0 });
  expect(snapshot!.raw).toBe(`id: 0\ndata: ${JSON.stringify({ t: "snapshot", version: 0, value: "line1\nline2" })}`);
  stream.publish("default", "x");
  const [, , change] = await c.until(3);
  expect(change!.id).toBe("1");
  expect(JSON.parse(change!.data[0]!)).toEqual({ t: "change", version: 1, change: "x" });
});

it("web: Last-Event-ID 로 이어 받는다", async () => {
  const stream = createStreamServer({ snapshot: () => "s" });
  cleanup.push(() => stream.close());
  const h = streamHandler(stream);
  const first = await sseOpen(h);
  const [w] = await first.messages(1);
  const epoch = (w as Extract<ServerMessage, { t: "welcome" }>).epoch;
  for (const v of ["x", "y", "z"]) stream.publish("default", v);
  await first.until(5);
  first.abort();
  const again = await sseOpen(h, { "x-supa-epoch": epoch, "last-event-id": "1" });
  expect(await again.messages(3)).toEqual([
    { t: "welcome", epoch, version: 3, connection: expect.any(String) },
    { t: "change", version: 2, change: "y" },
    { t: "change", version: 3, change: "z" },
  ]);
});

it("web: POST command 가 reply 를 본문으로 준다", async () => {
  const stream: StreamServer<string[], string, string> = createStreamServer<string[], string, string>({
    authorize: (ctx) => ctx.token ?? ctx.reject("토큰이 없다"),
    snapshot: () => [],
    commands: {
      add: (ctx, v: string): string => {
        stream.publish(ctx.channel, v);
        return `${ctx.identity}:${v}`;
      },
    },
  });
  cleanup.push(() => stream.close());
  const h = streamHandler(stream);
  const c = await sseOpen(h, { authorization: "Bearer amy", "x-supa-channel": "room" });
  const [w] = await c.messages(1);
  const connection = (w as Extract<ServerMessage, { t: "welcome" }>).connection;
  const mine = { authorization: "Bearer amy", "x-supa-channel": "room", "x-supa-connection": connection };

  const res = await post(h, mine, { t: "command", id: "c1", name: "add", args: ["a"] });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await res.json()).toEqual({ t: "reply", id: "c1", ok: true, result: "amy:a", version: 1 });
  const asked = await post(h, mine, { t: "ask", ids: ["c1", "c9"] });
  expect(await asked.json()).toEqual([
    { t: "fate", id: "c1", state: "done", ok: true, result: "amy:a", version: 1 },
    { t: "fate", id: "c9", state: "unknown-id" },
  ]);
  expect((await post(h, mine, { t: "answer", id: "r1", ok: true, result: 1 })).status).toBe(204);
  expect((await post(h, { ...mine, authorization: "Bearer bob" }, { t: "ask", ids: [] })).status).toBe(403);
  expect((await post(h, { ...mine, authorization: "" }, { t: "ask", ids: [] })).status).toBe(401);
  expect((await post(h, { ...mine, "x-supa-connection": "nope" }, { t: "ask", ids: [] })).status).toBe(404);
  expect((await h(new Request(URL_, { method: "POST", headers: mine, body: "{" }))).status).toBe(400);
});

it("web: 첫 send 전 close 라 4001 은 401, 4000 은 503", async () => {
  const stream = createStreamServer({
    authorize: (ctx) => (ctx.token === "ok" ? "me" : ctx.reject("인증 실패")),
    snapshot: () => 0,
  });
  cleanup.push(() => stream.close());
  const res = await streamHandler(stream)(
    new Request(URL_, { headers: { accept: "text/event-stream", authorization: "Bearer bad" } }),
  );
  expect(res.status).toBe(401);
  expect(await res.text()).toBe("인증 실패");

  const boom = createStreamServer({
    authorize: () => {
      throw new Error("db down");
    },
    snapshot: () => 0,
  });
  cleanup.push(() => boom.close());
  const res2 = await streamHandler(boom)(new Request(URL_, { headers: { accept: "text/event-stream" } }));
  expect(res2.status).toBe(503);
});

it("web: 본문이 1 MiB 를 넘는 POST 는 413", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  cleanup.push(() => stream.close());
  const res = await streamHandler(stream)(new Request(URL_, { method: "POST", body: "x".repeat((1 << 20) + 1) }));
  expect(res.status).toBe(413);
});

it("web: Upgrade: websocket 이면 426", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  cleanup.push(() => stream.close());
  const res = await streamHandler(stream)(new Request(URL_, { headers: { upgrade: "websocket" } }));
  expect(res.status).toBe(426);
  expect(await res.text()).toBe('Web 표준 처리기는 SSE 만 받는다 — transport: "sse" 를 쓴다');
});

it("web: 클라이언트가 본문 읽기를 그만두면(abort) 그 연결이 홉에서 떨어진다", async () => {
  const real = createStreamServer({ snapshot: () => 0 });
  cleanup.push(() => real.close());
  const conns: Conn[] = [];
  const spy: StreamServer<any, any, any> = { ...real, attach: (c) => (conns.push(c), real.attach(c)) };
  const h = streamHandler(spy);

  // 본문 읽기를 그만둔다(cancel)
  const a = await sseOpen(h);
  await a.until(1);
  const onA = vi.fn();
  conns[0]!.onClose(onA);
  await a.reader.cancel();
  expect(onA).toHaveBeenCalled();

  // 요청 signal 이 abort 된다
  const b = await sseOpen(h);
  await b.until(1);
  const onB = vi.fn();
  conns[1]!.onClose(onB);
  b.abort();
  await vi.waitFor(() => expect(onB).toHaveBeenCalled());
});

it("web: 겉의 send 는 JSON 으로 쓸 수 없는 메시지에 던지지 않고 그 연결을 닫는다. POST 의 본문이면 500", async () => {
  const threw: string[] = [];
  const stub: StreamServer<any, any, any> = {
    publish() {},
    close() {},
    attach(conn: Conn) {
      conn.send({ t: "welcome", epoch: "e", version: 0, connection: "k" });
      try {
        conn.send({ t: "snapshot", version: 0, value: 1n });
      } catch {
        threw.push(conn.kind);
      }
    },
    handlePost: async () => ({ status: 200, body: { n: 1n } }),
  };
  const h = streamHandler(stub);
  const c = await sseOpen(h);
  expect((await c.messages(2)).map((m) => m.t)).toEqual(["welcome", "close"]);
  expect(threw).toEqual([]);
  const res = await post(h, {}, {}).catch(() => null);
  expect(res?.status).toBe(500);
});

it("web: origins 를 주면 목록 밖 Origin 의 SSE · POST 는 403, Origin 이 없거나 목록 안이면 받는다", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  cleanup.push(() => stream.close());
  const h = streamHandler(stream, { origins: ["https://app.example"] });
  const evil = { origin: "https://evil.example" };
  expect((await h(new Request(URL_, { headers: { accept: "text/event-stream", ...evil } }))).status).toBe(403);
  expect((await post(h, evil, { t: "ask", ids: [] })).status).toBe(403);
  expect((await sseOpen(h, { origin: "https://app.example" })).res.status).toBe(200);
  expect((await sseOpen(h)).res.status).toBe(200);
});

it("web: 본문을 읽지 않으면 buffered() 가 쌓이고 읽으면 줄며, maxBuffered 를 넘으면 4000 으로 닫는다", async () => {
  const LIMIT = 64 * 1024;
  const stream = createStreamServer<number, string>({ snapshot: () => 0, maxBuffered: LIMIT });
  cleanup.push(() => stream.close());
  const conns: Conn[] = [];
  const attach = stream.attach;
  stream.attach = (c) => void (conns.push(c), attach(c));
  const c = await sseOpen(streamHandler(stream));
  const conn = conns[0]!;
  const before = conn.buffered(); // welcome · snapshot 이 읽히지 않고 있다
  expect(before).toBeGreaterThan(0);
  stream.publish("default", "x".repeat(1000));
  expect(conn.buffered()).toBeGreaterThan(before + 1000);
  await c.until(3);
  expect(conn.buffered()).toBe(0);
  // 다시 읽지 않고 큰 바뀜을 보낸다 — 한도를 넘긴 뒤의 publish 에서 닫힌다
  const big = "x".repeat(16 * 1024);
  for (let i = 0; i < 10; i++) stream.publish("default", big);
  expect(conn.buffered()).toBeGreaterThan(LIMIT);
  expect(conn.buffered()).toBeLessThan(LIMIT + 2 * big.length);
  const rest = await c.messages(100);
  expect(rest.at(-1)).toEqual({ t: "close", code: 4000, reason: "버퍼가 넘쳤다" });
  // 앞의 작은 것 하나 + 큰 것 넷(넷째 뒤 쌓인 양이 처음 한도를 넘는다) — 다섯째 publish 에서 닫힌다
  expect(rest.filter((m) => m.t === "change")).toHaveLength(1 + 4);
  expect(() => conn.buffered()).not.toThrow();
});
