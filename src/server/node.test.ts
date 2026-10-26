// @vitest-environment node
import { once } from "node:events";
import http from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerMessage } from "../stream/protocol.js";
import { createStreamServer, type StreamServer } from "./core.js";
import { attachStream } from "./node.js";

const PATH = "/ws/t";
/** 시험마다 닫을 것 — 서버 · 홉 · 소켓이 남으면 vitest 가 끝나지 않는다 */
let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** 실제 http 서버를 띄우고 attachStream 을 붙인다 — prior 는 붙이기 전에 있던 요청 처리기 */
async function serve(stream: StreamServer<any, any, any>, prior?: http.RequestListener) {
  const server = http.createServer(prior);
  const detach = attachStream(server, { path: PATH, stream });
  server.listen(0);
  await once(server, "listening");
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    stream.close();
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return { server, detach, http: `http://${base}${PATH}`, ws: `ws://${base}${PATH}` };
}

/** 웹소켓 — 받은 메시지를 쌓고, n 번째가 올 때까지 기다린다 */
async function wsOpen(url: string) {
  const ws = new WebSocket(url);
  const got: ServerMessage[] = [];
  let wake = () => {};
  ws.onmessage = (e) => {
    got.push(JSON.parse(String(e.data)));
    wake();
  };
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
  cleanup.push(() => ws.close());
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const until = async (n: number) => {
    while (got.length < n) await new Promise<void>((r) => (wake = r));
    return got.slice(0, n);
  };
  return { ws, got, until, closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** SSE — fetch 의 본문을 빈 줄로 나눠 이벤트로 읽는다 */
async function sseOpen(url: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: abort.signal });
  cleanup.push(() => abort.abort());
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: Array<{ id?: string; data: string[]; raw: string }> = [];
  /** n 개째 이벤트까지 — 본문이 끝나면 그때까지 받은 것 */
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
  return { res, until, messages, abort: () => abort.abort() };
}

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

it("node: 웹소켓으로 hello → welcome · snapshot 을 받고 publish 한 change 를 받는다", async () => {
  const stream = createStreamServer<string[], string>({ snapshot: () => ["a"] });
  const { ws } = await serve(stream);
  const c = await wsOpen(ws);
  c.send({ t: "hello" });
  expect(await c.until(2)).toEqual([
    { t: "welcome", epoch: expect.any(String), version: 0, connection: expect.any(String) },
    { t: "snapshot", version: 0, value: ["a"] },
  ]);
  stream.publish("default", "b");
  expect((await c.until(3))[2]).toEqual({ t: "change", version: 1, change: "b" });
});

it("node: SSE 로 같은 메시지를 data: 한 줄 JSON 으로 받고, snapshot · change 에 id: 버전이 붙는다", async () => {
  const stream = createStreamServer({ snapshot: () => "line1\nline2" });
  const { http } = await serve(stream);
  const c = await sseOpen(http);
  expect(c.res.status).toBe(200);
  expect(c.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  // 프록시가 쌓아 두거나 고치지 않게
  expect(c.res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(c.res.headers.get("x-accel-buffering")).toBe("no");
  const [welcome, snapshot] = await c.until(2);
  // welcome 에는 id 가 없다 — 버전이 없는 메시지로 Last-Event-ID 를 덮지 않게
  expect(welcome!.id).toBeUndefined();
  expect(welcome!.data).toHaveLength(1);
  expect(JSON.parse(welcome!.data[0]!)).toMatchObject({ t: "welcome", version: 0 });
  // 값에 줄바꿈이 있어도 data: 는 한 줄이다. event: 줄은 없다
  expect(snapshot!.raw).toBe(`id: 0\ndata: ${JSON.stringify({ t: "snapshot", version: 0, value: "line1\nline2" })}`);
  stream.publish("default", "x");
  const [, , change] = await c.until(3);
  expect(change!.id).toBe("1");
  expect(JSON.parse(change!.data[0]!)).toEqual({ t: "change", version: 1, change: "x" });
});

it("node: SSE 다시 이음 — Last-Event-ID 의 버전 뒤부터 받는다", async () => {
  const stream = createStreamServer({ snapshot: () => "s" });
  const { http } = await serve(stream);
  const first = await sseOpen(http);
  const [w] = await first.messages(1);
  const epoch = (w as Extract<ServerMessage, { t: "welcome" }>).epoch;
  stream.publish("default", "x");
  stream.publish("default", "y");
  stream.publish("default", "z");
  await first.until(5);
  first.abort();
  const again = await sseOpen(http, { "x-supa-epoch": epoch, "last-event-id": "1" });
  expect(await again.messages(3)).toEqual([
    { t: "welcome", epoch, version: 3, connection: expect.any(String) },
    { t: "change", version: 2, change: "y" },
    { t: "change", version: 3, change: "z" },
  ]);
});

it("node: POST command 는 X-Supa-Connection 의 연결로 묶이고 그 응답 본문이 reply 다. 다른 신원이면 403", async () => {
  const stream = createStreamServer<string[], string, string>({
    authorize: (ctx) => ctx.token ?? ctx.reject("토큰이 없다"),
    snapshot: () => [],
    commands: {
      add: (ctx, v: string) => {
        stream.publish(ctx.channel, v);
        return `${ctx.identity}:${v}`;
      },
    },
  });
  const { http } = await serve(stream);
  const c = await sseOpen(http, { authorization: "Bearer amy", "x-supa-channel": "room" });
  const [w] = await c.messages(1);
  const connection = (w as Extract<ServerMessage, { t: "welcome" }>).connection;
  const mine = { authorization: "Bearer amy", "x-supa-channel": "room", "x-supa-connection": connection };

  const res = await post(http, mine, { t: "command", id: "c1", name: "add", args: ["a"] });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await res.json()).toEqual({ t: "reply", id: "c1", ok: true, result: "amy:a", version: 1 });
  // 명령이 낸 바뀜은 그 스트림으로 온다
  expect((await c.messages(3))[2]).toEqual({ t: "change", version: 1, change: "a" });

  const asked = await post(http, mine, { t: "ask", ids: ["c1", "c9"] });
  expect(await asked.json()).toEqual([
    { t: "fate", id: "c1", state: "done", ok: true, result: "amy:a", version: 1 },
    { t: "fate", id: "c9", state: "unknown-id" },
  ]);
  expect((await post(http, mine, { t: "answer", id: "r1", ok: true, result: 1 })).status).toBe(204);

  const other = await post(http, { ...mine, authorization: "Bearer bob" }, { t: "command", id: "c2", name: "add", args: ["b"] });
  expect(other.status).toBe(403);
  expect((await post(http, { ...mine, authorization: "" }, { t: "ask", ids: [] })).status).toBe(401);
  expect((await post(http, { ...mine, "x-supa-connection": "nope" }, { t: "ask", ids: [] })).status).toBe(404);
  expect((await fetch(http, { method: "POST", headers: mine, body: "{" })).status).toBe(400);
});

it("node: Authorization 이 거절되면 SSE 는 401, 웹소켓은 4001", async () => {
  const stream = createStreamServer({
    authorize: (ctx) => (ctx.token === "ok" ? "me" : ctx.reject("인증 실패")),
    snapshot: () => 0,
  });
  const { http, ws } = await serve(stream);
  const sse = await fetch(http, { headers: { accept: "text/event-stream", authorization: "Bearer bad" } });
  expect(sse.status).toBe(401);
  expect(await sse.text()).toBe("인증 실패");

  const c = await wsOpen(ws);
  c.send({ t: "hello", auth: "bad" });
  const closed = await c.closed;
  expect(closed.code).toBe(4001);
  expect(closed.reason).toBe("인증 실패");
});

it("node: 떼어 내면 열린 연결이 모두 닫히고 이벤트 리스너가 남지 않는다", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  const { server, detach, http, ws } = await serve(stream, (_req, res) => res.end("app"));
  // 그 path 밖의 요청은 앞서 붙어 있던 처리기가 받는다
  expect(await (await fetch(http.replace(PATH, "/other"))).text()).toBe("app");

  const w = await wsOpen(ws);
  w.send({ t: "hello" });
  await w.until(2);
  const s = await sseOpen(http);
  await s.until(2);

  detach();
  expect((await w.closed).code).toBe(4000);
  // SSE 는 보낸 뒤에 닫히므로 close 메시지를 쓰고 끝난다
  const all = await s.messages(10);
  expect(all).toHaveLength(3);
  expect(all[2]).toMatchObject({ t: "close", code: 4000 });

  // 붙이기 전의 처리기 하나만 남는다
  expect(server.listenerCount("request")).toBe(1);
  expect(server.listenerCount("upgrade")).toBe(0);
  // 떼어 낸 뒤 그 path 는 앞의 처리기가 받는다
  expect(await (await fetch(http)).text()).toBe("app");
});

it("node: ws 가 없으면 웹소켓 Upgrade 는 「ws 를 설치한다」로 실패하고 SSE 는 그대로 돈다", async () => {
  vi.doMock("ws", () => {
    throw new Error("Cannot find package 'ws'");
  });
  cleanup.push(() => vi.doUnmock("ws"));
  const stream = createStreamServer({ snapshot: () => 0 });
  const { http, ws } = await serve(stream);
  // 브라우저 꼴 클라이언트는 실패의 본문을 주지 않으므로 날 소켓으로 Upgrade 를 보내 응답을 읽는다
  const sock = rawUpgrade(ws);
  let text = "";
  sock.on("data", (d) => (text += d));
  await once(sock, "end");
  expect(text).toMatch(/^HTTP\/1\.1 501/);
  expect(text).toContain("ws 를 설치한다");
  const c = await sseOpen(http);
  expect((await c.messages(2)).map((m) => m.t)).toEqual(["welcome", "snapshot"]);
});

it("node: 망가진 웹소켓 프레임이 와도 프로세스는 살고 새 연결을 받는다", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  const { ws } = await serve(stream);
  const sock = rawUpgrade(ws);
  const [head] = await once(sock, "data");
  expect(String(head)).toMatch(/^HTTP\/1\.1 101/);
  // 클라이언트 프레임은 가려야(mask) 한다 — 가리지 않은 프레임이면 ws 가 error 를 낸다
  sock.write(Buffer.from([0x81, 0x01, 0x41]));
  await once(sock, "close");
  const c = await wsOpen(ws);
  c.send({ t: "hello" });
  expect((await c.until(2)).map((m) => m.t)).toEqual(["welcome", "snapshot"]);
});

it("node: 한 서버에 두 번 붙이면 던지고, 떼어 낸 뒤에는 다시 붙는다", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  const { server, detach } = await serve(stream);
  expect(() => attachStream(server, { path: "/other", stream })).toThrow(/한 번만/);
  detach();
  attachStream(server, { path: "/other", stream })();
});

it("node: POST 본문이 1 MiB 를 넘으면 413 을 받는다", async () => {
  const stream = createStreamServer({ snapshot: () => 0 });
  const { http } = await serve(stream);
  const res = await fetch(http, { method: "POST", body: "x".repeat((1 << 20) + 1) });
  expect(res.status).toBe(413);
});

/** 날 소켓으로 웹소켓 Upgrade 요청을 보낸다 — 브라우저 꼴 클라이언트가 못 보내는 것을 보내려고 */
function rawUpgrade(wsUrl: string) {
  const url = new URL(wsUrl);
  const sock = connect(Number(url.port), url.hostname);
  cleanup.push(() => sock.destroy());
  sock.write(
    `GET ${PATH} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  return sock;
}
