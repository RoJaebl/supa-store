// @vitest-environment node
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamServer, type StreamServer } from "../server/core.js";
import { attachStream } from "../server/node.js";
import { connect, sseParser, TIMING, type ClientOptions, type ClientView, type StreamClient } from "./client.js";
import { TEXT, type ClientMessage, type ServerMessage } from "./protocol.js";

const PATH = "/s";
/** 시험마다 닫을 것 — 클라이언트 · 서버 · 홉이 남으면 vitest 가 끝나지 않는다 */
let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 실제 http 서버에 홉을 붙인다 — swap 으로 홉을 갈아 끼우고(새 epoch), kill 로 열린 소켓을 모두 끊는다 */
async function serve(first: StreamServer<any, any, any>) {
  const server = http.createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  let stream = first;
  let detach = attachStream(server, { path: PATH, stream });
  server.listen(0);
  await once(server, "listening");
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    detach();
    stream.close();
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return {
    server,
    url: (t: "ws" | "sse") => (t === "ws" ? `ws://${base}${PATH}` : `http://${base}${PATH}`),
    kill: () => sockets.forEach((s) => s.destroy()),
    swap(next: StreamServer<any, any, any>) {
      detach();
      stream.close();
      stream = next;
      detach = attachStream(server, { path: PATH, stream });
    },
  };
}

/** 실제 서버 시험의 다시 잇기 첫 간격 — 1초를 기다리지 않게 줄인다(가짜 시계 시험은 기본 값) */
const GAP = 20;
type Opts<V, C> = ClientOptions<V, C> & { [TIMING]?: number };

function open<V, C = V>(o: Opts<V, C>) {
  const c = connect({ [TIMING]: GAP, ...o } as ClientOptions<V, C>);
  cleanup.push(() => c.close());
  return c;
}

/** view 가 조건을 채울 때까지 — 오래 걸리면 지금 view 를 보이며 실패한다 */
function until<V>(c: StreamClient<V>, ok: (v: ClientView<V>) => boolean, ms = 4000) {
  return new Promise<ClientView<V>>((resolve, reject) => {
    if (ok(c.view())) return resolve(c.view());
    const timer = setTimeout(() => (off(), reject(new Error(`기다림 끝: ${JSON.stringify(c.view())}`))), ms);
    const off = c.subscribe(() => {
      if (!ok(c.view())) return;
      clearTimeout(timer);
      off();
      resolve(c.view());
    });
  });
}
const settled = <V>(c: StreamClient<V>) => until(c, (v) => v.status === "ready" && !v.isFetching);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 실패한 명령의 오류 — message 와 requestId */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("풀리면 안 된다");
    },
    (e: Error & { requestId: string }) => ({ message: e.message, requestId: e.requestId }),
  );

const both = ["ws", "sse"] as const;

describe.each(both)("%s", (transport) => {
  it("client: 처음 연결 중 loading · isFetching, welcome 의 버전에 이르면 ready · isFetching false", async () => {
    const stream = createStreamServer<string[], string>({ snapshot: () => ["a"] });
    const s = await serve(stream);
    stream.publish("default", "x"); // 버전 1
    const c = open<string[]>({ url: s.url(transport), transport });
    expect(c.view()).toEqual({ data: undefined, status: "loading", isFetching: true, error: null });
    expect(await settled(c)).toEqual({ data: ["a"], status: "ready", isFetching: false, error: null });
  });

  it("client: reduce 로 change 를 합치고, reduce 가 없으면 change 를 새 값으로 본다", async () => {
    const stream = createStreamServer<string[], string>({ snapshot: () => ["a"] });
    const s = await serve(stream);
    const r = open<string[], string>({ url: s.url(transport), transport, reduce: (v, c) => [...v, c] });
    const plain = open<string[]>({ url: s.url(transport), transport });
    await settled(r);
    await settled(plain);
    stream.publish("default", "b");
    expect((await until(r, (v) => v.data!.length === 2)).data).toEqual(["a", "b"]);
    expect((await until(plain, (v) => !Array.isArray(v.data))).data).toBe("b");
  });

  it("client: 끊기면 마지막 값을 쥔 채 ready · isFetching true · 연결 끊김. 재시도 중.. — 다시 이으면 빠진 change 만 받아 따라잡는다", async () => {
    const snapshot = vi.fn(() => [] as string[]);
    const stream = createStreamServer<string[], string>({ snapshot });
    const s = await serve(stream);
    const c = open<string[], string>({ url: s.url(transport), transport, reduce: (v, x) => [...v, x] });
    await settled(c);
    stream.publish("default", "a");
    await until(c, (v) => v.data!.length === 1);
    s.kill();
    expect(await until(c, (v) => v.isFetching)).toEqual({
      data: ["a"],
      status: "ready",
      isFetching: true,
      error: TEXT.reconnecting,
    });
    stream.publish("default", "b");
    stream.publish("default", "c");
    expect(await until(c, (v) => !v.isFetching)).toEqual({ data: ["a", "b", "c"], status: "ready", isFetching: false, error: null });
    // 기록 안이므로 snapshot 은 처음 한 번뿐 — 두 번 덧붙지 않는다
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("client: 4001 이면 다시 잇지 않고 error — 처음 거절이면 data 는 undefined (SSE 는 HTTP 401)", async () => {
    const authorize = vi.fn((ctx: { reject(r: string): never }) => ctx.reject("인증 실패"));
    const stream = createStreamServer({ authorize, snapshot: () => 0 });
    const s = await serve(stream);
    const c = open({ url: s.url(transport), transport });
    expect(await until(c, (v) => v.status === "error")).toEqual({
      data: undefined,
      status: "error",
      isFetching: false,
      error: "인증 실패",
    });
    await sleep(GAP * 10); // 다시 잇는다면 첫 간격 ±20% 안에 다시 온다
    expect(authorize).toHaveBeenCalledTimes(1);
    await expect(failure(c.command("x", []))).resolves.toMatchObject({ message: TEXT.commandFailed });
  });

  it("client: epoch 가 바뀌면 snapshot 으로 다시 시작하고 같은 번호의 change 도 받는다", async () => {
    const a = createStreamServer<string[], string>({ snapshot: () => ["a0"] });
    const s = await serve(a);
    const c = open<string[], string>({ url: s.url(transport), transport, reduce: (v, x) => [...v, x] });
    await settled(c);
    a.publish("default", "a1"); // 버전 1
    await until(c, (v) => v.data!.length === 2);
    // 서버가 다시 떴다 — 버전이 0 부터 다시 센다
    const b = createStreamServer<string[], string>({ snapshot: () => ["b0"] });
    s.swap(b);
    await until(c, (v) => v.data![0] === "b0");
    b.publish("default", "b1"); // 버전 1 — 앞 epoch 의 버전 1 과 같은 번호
    expect((await until(c, (v) => v.data!.length === 2)).data).toEqual(["b0", "b1"]);
  });

  it("client: command 는 그 명령이 낸 바뀜이 data 에 든 뒤에 풀린다", async () => {
    const stream = createStreamServer<string[], string>({
      snapshot: () => [],
      commands: {
        add: (ctx, v: string) => {
          stream.publish(ctx.channel, v);
          return v.toUpperCase();
        },
      },
    });
    const s = await serve(stream);
    const c = open<string[], string>({ url: s.url(transport), transport, reduce: (v, x) => [...v, x] });
    await settled(c);
    expect(await c.command("add", ["a"])).toBe("A");
    expect(c.view().data).toEqual(["a"]);
    // 앱의 ok: false 는 앱의 문구 그대로 — version 0 을 기다리지 않는다
    await expect(failure(c.command("nope", [], "r1"))).resolves.toEqual({ message: "알 수 없는 명령: nope", requestId: "r1" });
  });

  it("client: 보낸 뒤 끊긴 command 는 다시 이으면 ask 로 done · unknown-id · running 에 맞게 끝난다. 확인하지 못하면 연결 끊김. 알 수 없음", async () => {
    let gate = () => {};
    const ran = { done: 0, running: 0 };
    let s!: Awaited<ReturnType<typeof serve>>;
    const make = (count?: number) =>
      createStreamServer<number>({
        snapshot: () => 0,
        history: count === undefined ? undefined : { count },
        commands: {
          // 답을 내기 전에 연결을 끊는다 — 답은 닫힌 연결로 가서 버려진다
          done: () => (ran.done++, s.kill(), "D"),
          running: () => (ran.running++, s.kill(), new Promise((r) => (gate = () => r("R")))),
        },
      });
    s = await serve(make());
    const c = open<number>({ url: s.url(transport), transport });
    await settled(c);
    // done — 홉이 쥔 답으로 끝난다
    expect(await c.command("done", [])).toBe("D");
    await settled(c);
    // running — 같은 id 로 다시 보내 그 답을 받는다. 두 번 돌지 않는다
    const r = c.command("running", []);
    await until(c, (v) => v.isFetching);
    await settled(c);
    await sleep(50);
    gate();
    expect(await r).toBe("R");
    expect(ran).toEqual({ done: 1, running: 1 });

    // unknown-id — 답 기록을 쥐지 않는 홉(count 0)은 받은 적 없다고 답한다
    s.swap(make(0));
    await until(c, (v) => v.isFetching);
    await settled(c);
    await expect(failure(c.command("done", []))).resolves.toMatchObject({ message: TEXT.commandFailed });

    // 확인하지 못함 — 다시 이었더니 서버가 다시 떴다(epoch 가 다르다)
    await settled(c);
    const lost = c.command("running", []);
    await until(c, (v) => v.isFetching);
    s.swap(make());
    await expect(failure(lost)).resolves.toMatchObject({ message: TEXT.unknown });
  });

  it("client: 같은 id 로 다시 보내면 서버가 두 번 실행하지 않는다", async () => {
    let n = 0;
    const stream = createStreamServer({ snapshot: () => 0, commands: { inc: () => ++n } });
    const s = await serve(stream);
    const c = open({ url: s.url(transport), transport });
    await settled(c);
    expect(await c.command("inc", [], "same")).toBe(1);
    expect(await c.command("inc", [], "same")).toBe(1);
    expect(n).toBe(1);
  });

  it("client: 서버의 request 에 handlers 가 answer 로 답하고, 없는 이름은 ok: false", async () => {
    const stream = createStreamServer({
      snapshot: () => 0,
      commands: {
        ask: async (ctx) => {
          const yes = await ctx.request("confirm", ["지울까?"]);
          const nope = await ctx.request("nope").catch((e: Error) => e.message);
          const boom = await ctx.request("boom").catch((e: Error) => e.message);
          return { yes, nope, boom };
        },
      },
    });
    const s = await serve(stream);
    const c = open({
      url: s.url(transport),
      transport,
      handlers: {
        confirm: (m: string) => `예: ${m}`,
        boom: () => {
          throw new Error("터짐");
        },
      },
    });
    await settled(c);
    expect(await c.command("ask", [])).toEqual({ yes: "예: 지울까?", nope: "알 수 없는 요청: nope", boom: "터짐" });
  });

  it("client: auth() 를 다시 이을 때마다 부르고, 토큰이 주소에 실리지 않는다", async () => {
    const tokens: Array<string | undefined> = [];
    const stream = createStreamServer({
      // 신원은 토큰이 바뀌어도 같다 — SSE 의 POST 는 그 연결의 신원과 같아야 받는다
      authorize: (ctx) => (tokens.push(ctx.token), "me"),
      snapshot: () => 0,
      commands: { token: (ctx) => ctx.token },
    });
    const s = await serve(stream);
    const urls: string[] = [];
    s.server.prependListener("request", (req) => void urls.push(req.url!));
    s.server.prependListener("upgrade", (req) => void urls.push(req.url!));
    let n = 0;
    const c = open({ url: s.url(transport), transport, auth: async () => `t${++n}` });
    await settled(c);
    const first = await c.command("token", []);
    s.kill();
    await until(c, (v) => v.isFetching);
    await settled(c);
    // 다시 이은 연결은 새 토큰으로 섰다
    expect(await c.command("token", [])).not.toBe(first);
    // 웹소켓은 hello 로, SSE 는 GET 과 POST 마다 Authorization 으로 — 부를 때마다 auth() 의 새 값
    expect(tokens).toEqual(transport === "ws" ? ["t1", "t2"] : ["t1", "t2", "t3", "t4"]);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((u) => u === PATH)).toBe(true);
  });

  it("client: close() 뒤 연결이 닫히고 다시 잇지 않으며 리스너를 부르지 않는다", async () => {
    let attaches = 0;
    const stream = createStreamServer({ authorize: () => void attaches++, snapshot: () => 0 });
    const s = await serve(stream);
    const c = connect({ url: s.url(transport), transport, [TIMING]: GAP } as ClientOptions<number, number>);
    await settled(c);
    const seen = vi.fn();
    c.subscribe(seen);
    s.kill();
    await until(c, (v) => v.isFetching);
    c.close(); // 다시 잇기를 기다리는 중에 닫는다
    seen.mockClear();
    await sleep(GAP * 10);
    expect(attaches).toBe(1);
    expect(seen).not.toHaveBeenCalled();
  });
});

it("client: SSE 는 fetch 스트림으로 받고 Authorization · Last-Event-ID 헤더를 싣는다", async () => {
  const heads: Array<Record<string, string | undefined>> = [];
  const stream = createStreamServer<number>({
    authorize: (ctx) => (heads.push(ctx.headers), "me"),
    snapshot: () => 0,
    commands: { ok: () => 1 },
  });
  const s = await serve(stream);
  const c = open<number>({ url: s.url("sse"), transport: "sse", channel: "room", auth: () => "tok" });
  await settled(c);
  stream.publish("room", 7);
  await until(c, (v) => v.data === 7);
  s.kill();
  await until(c, (v) => v.isFetching);
  await settled(c);
  expect(await c.command("ok", [])).toBe(1);
  const [first, again, posted] = heads;
  expect(first).toMatchObject({ authorization: "Bearer tok", "x-supa-channel": "room", accept: "text/event-stream" });
  expect(first!["last-event-id"]).toBeUndefined();
  expect(again).toMatchObject({ authorization: "Bearer tok", "x-supa-channel": "room", "last-event-id": "1" });
  expect(again!["x-supa-epoch"]).toEqual(expect.any(String));
  // POST 는 스트림의 채널과 연결을 다시 밝힌다
  expect(posted).toMatchObject({ authorization: "Bearer tok", "x-supa-channel": "room", "x-supa-connection": expect.any(String) });
});

it("client: SSE 의 망가진 프레임은 버리고 연결을 살리며, CRLF 로 쓰는 서버도 읽는다", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const w = (m: unknown) => `data: ${JSON.stringify(m)}\r\n\r\n`;
    res.write(w({ t: "welcome", epoch: "e", version: 0, connection: "k" }));
    res.write("data: {망가짐\r\n\r\n");
    res.write(`id: 0\r\n${w({ t: "snapshot", version: 0, value: "ok" })}`);
  });
  server.listen(0);
  await once(server, "listening");
  cleanup.push(() => (server.closeAllConnections(), new Promise((r) => server.close(r))));
  const c = open<string>({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, transport: "sse" });
  expect(await settled(c)).toEqual({ data: "ok", status: "ready", isFetching: false, error: null });
});

it("client: SSE 에서 ask 의 POST 가 막히면 그 명령은 연결 끊김. 알 수 없음", async () => {
  let block = false;
  let s!: Awaited<ReturnType<typeof serve>>;
  const stream = createStreamServer({
    // 다시 이은 뒤의 POST(연결이 있는 요청)만 거절한다 — GET 은 통과
    authorize: (ctx) => (block && ctx.headers["x-supa-connection"] ? ctx.reject("막힘") : "me"),
    snapshot: () => 0,
    commands: { cut: () => ((block = true), s.kill(), 1) },
  });
  s = await serve(stream);
  const c = open({ url: s.url("sse"), transport: "sse" });
  await settled(c);
  await expect(failure(c.command("cut", []))).resolves.toMatchObject({ message: TEXT.unknown });
});

// ── 시계가 걸린 것 — 가짜 웹소켓과 가짜 타이머로 본다 ──

/** 받은 것을 쌓는 가짜 웹소켓 — 시험이 open · recv · drop 으로 서버 노릇을 한다 */
class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  closed?: number;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close(code = 1000) {
    this.closed = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** 가짜 시계 · 가짜 웹소켓으로 연결 하나를 연다 — welcome 까지 받으면 live 가 그 소켓 */
async function fake<V = unknown, C = V>(o: Partial<Opts<V, C>> = {}) {
  if (!vi.isFakeTimers()) vi.useFakeTimers();
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  const c = open<V, C>({ url: "ws://x/s", [TIMING]: undefined, ...o });
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  const last = () => FakeWS.all[FakeWS.all.length - 1]!;
  /** 새 소켓을 열고 welcome 을 준다 */
  const live = async (version = 0, epoch = "e1") => {
    await tick();
    const ws = last();
    ws.open();
    ws.recv({ t: "welcome", epoch, version, connection: "k" });
    return ws;
  };
  return { c, tick, last, live };
}

it("client: 다시 잇기 간격은 1초부터 두 배, 30초에서 멈추고 ±20% 안이다", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const first = await fake();
  const { tick, last } = first;
  await tick();
  for (const gap of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const n = FakeWS.all.length;
    last().drop();
    await tick(gap - 1);
    expect(FakeWS.all.length).toBe(n);
    await tick(1);
    expect(FakeWS.all.length).toBe(n + 1);
  }
  first.c.close();
  // 흔들기 — 가장 짧으면 0.8초, 가장 길면 1.2초
  for (const [r, ms] of [
    [0, 800],
    [0.9999, 1200],
  ] as const) {
    vi.spyOn(Math, "random").mockReturnValue(r);
    const { c, tick, live } = await fake();
    const ws = await live();
    ws.recv({ t: "snapshot", version: 0, value: 0 }); // 이어지면 1초로 되돌린다
    ws.drop();
    const n = FakeWS.all.length;
    await tick(ms - 1);
    expect(FakeWS.all.length).toBe(n);
    await tick(1);
    expect(FakeWS.all.length).toBe(n + 1);
    c.close();
  }
});

it("client: 60초 동안 아무것도 받지 못하면 끊긴 것으로 보고 다시 잇는다", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { c, tick, live } = await fake();
  const ws = await live();
  ws.recv({ t: "snapshot", version: 0, value: 1 });
  await tick(59_999);
  ws.recv({ t: "ping" }); // 무엇이든 받으면 다시 센다 — ping 에는 pong
  expect(ws.sent.at(-1)).toEqual({ t: "pong" });
  await tick(59_999);
  expect(ws.closed).toBeUndefined();
  await tick(1);
  expect(ws.closed).toBeDefined();
  expect(c.view()).toMatchObject({ data: 1, status: "ready", isFetching: true, error: TEXT.reconnecting });
  await tick(1000);
  expect(FakeWS.all.length).toBe(2);
});

it("client: 4000 이면 곧바로 다시 잇는다 — 따라잡은 연결일 때만, 아니면 간격을 둔다", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { tick, live, last } = await fake();
  // welcome 전의 4000 — 내려간 홉이 곧바로 닫는 꼴
  await tick();
  last().drop(4000);
  await tick(0);
  expect(FakeWS.all.length).toBe(1);
  await tick(1000);
  expect(FakeWS.all.length).toBe(2);
  // welcome 뒤 snapshot 전의 4000 — snapshot 이 늘 실패하는 홉. 간격도 1초로 되돌리지 않는다
  last().open();
  last().recv({ t: "welcome", epoch: "e1", version: 0, connection: "k" });
  last().drop(4000, "snapshot 실패: x");
  await tick(1999);
  expect(FakeWS.all.length).toBe(2);
  await tick(1);
  expect(FakeWS.all.length).toBe(3);
  // 따라잡은 연결의 4000 은 곧바로
  const ws = await live();
  ws.recv({ t: "snapshot", version: 0, value: 1 });
  ws.drop(4000, "서버가 내려간다");
  await tick(0);
  expect(FakeWS.all.length).toBe(4);
});

it("client: 보안 문맥이 아니어 randomUUID 가 없어도 명령에 id 를 붙인다", async () => {
  const { c, live } = await fake();
  const ws = await live();
  ws.recv({ t: "snapshot", version: 0, value: 0 });
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
  void c.command("x", []).catch(() => {});
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", FakeWS);
  expect((ws.sent.at(-1) as { id: string }).id).toMatch(/^[0-9a-f]{32}$/);
});

it("client: SSE 읽기 — 조각으로 갈린 줄, 여러 줄 data, : 주석, CRLF · CR 줄 끝", () => {
  const got: string[] = [];
  const feed = sseParser((d) => got.push(d));
  // 조각 사이에서 갈린 줄과 빈 줄
  feed("id: 1\nda");
  feed("ta: {\"a\":1}\n");
  feed("\n");
  // 여러 줄 data 는 \n 으로 잇고, : 주석 · event 칸은 버린다
  feed(": keep-alive\nevent: x\ndata: one\ndata:two\ndata\n\n");
  // CRLF — \r 과 \n 이 다른 조각으로 와도 한 줄 끝이다
  feed("data: crlf\r");
  feed("\n\r\n");
  // CR 만
  feed("data: cr\r\rdata: next\n\n");
  // data 없는 이벤트는 넘기지 않는다
  feed("id: 9\n\n");
  expect(got).toEqual(['{"a":1}', "one\ntwo\n", "crlf", "cr", "next"]);
});


it("client: 가진 버전보다 작거나 같은 change 는 버리고, 하나 넘게 건너뛰면 다시 이어 따라잡는다", async () => {
  const { c, tick, live } = await fake<number[], number>({ reduce: (v, x) => [...v, x] });
  const ws = await live(1);
  ws.recv({ t: "snapshot", version: 1, value: [] });
  ws.recv({ t: "change", version: 2, change: 2 });
  ws.recv({ t: "change", version: 2, change: 2 });
  ws.recv({ t: "change", version: 1, change: 1 });
  expect(c.view().data).toEqual([2]);
  ws.recv({ t: "change", version: 4, change: 4 });
  expect(ws.closed).toBeDefined();
  expect(c.view().data).toEqual([2]);
  await tick(0);
  const again = FakeWS.all[1]!;
  again.open();
  expect(again.sent[0]).toEqual({ t: "hello", channel: "default", version: 2, epoch: "e1" });
});

it("client: 앞 연결의 늦은 change · reply 는 새 연결의 상태를 고치지 않는다", async () => {
  const { c, tick, live } = await fake<number>();
  const a = await live();
  a.recv({ t: "snapshot", version: 0, value: 0 });
  const p = c.command("x", []);
  const id = (a.sent.at(-1) as { id: string }).id;
  const late = a.onmessage!; // 떼어 낸 앞 연결의 받기 — 늦게 온 메시지 노릇
  a.drop(4000);
  const b = await live();
  late({ data: JSON.stringify({ t: "change", version: 1, change: 99 }) });
  late({ data: JSON.stringify({ t: "reply", id, ok: true, result: "old", version: 0 }) });
  expect(c.view().data).toBe(0);
  // 앞 연결의 명령은 새 연결에서 ask 로 묻는다
  expect(b.sent.at(-1)).toEqual({ t: "ask", ids: [id] });
  b.recv({ t: "fate", id, state: "done", ok: true, result: "new", version: 0 });
  expect(await p).toBe("new");
});

it("client: command 는 reply.version 에 data 가 이른 뒤에 풀린다. 이미 지난 버전이면 곧바로 풀린다", async () => {
  const { c, tick, live } = await fake<number>();
  const ws = await live(1);
  ws.recv({ t: "snapshot", version: 1, value: 1 });
  const done = vi.fn();
  void c.command("a", []).then(done);
  ws.recv({ t: "reply", id: (ws.sent.at(-1) as { id: string }).id, ok: true, result: "A", version: 3 });
  ws.recv({ t: "change", version: 2, change: 2 });
  await tick();
  expect(done).not.toHaveBeenCalled();
  ws.recv({ t: "change", version: 3, change: 3 });
  await tick();
  expect(done).toHaveBeenCalledWith("A");
  const q = c.command("b", []);
  ws.recv({ t: "reply", id: (ws.sent.at(-1) as { id: string }).id, ok: true, result: "B", version: 2 });
  expect(await q).toBe("B");
});

it("client: 끊긴 동안의 command 는 곧바로 연결 끊김. 명령 실패", async () => {
  const { c, tick, live } = await fake();
  // welcome 전에는 보내지 않는다
  await tick();
  await expect(failure(c.command("x", [], "r0"))).resolves.toEqual({ message: TEXT.commandFailed, requestId: "r0" });
  const ws = await live();
  ws.drop();
  await expect(failure(c.command("x", [], "r1"))).resolves.toEqual({ message: TEXT.commandFailed, requestId: "r1" });
  expect(ws.sent.filter((m) => m.t === "command")).toEqual([]);
});

it("client: 30초 안에 답이 없으면 응답 지연, 명령마다 timeout 을 바꿀 수 있다", async () => {
  const { c, tick, live } = await fake({ commands: { quick: { timeout: 5000 } } });
  const ws = await live();
  ws.recv({ t: "snapshot", version: 0, value: 0 });
  const slow = failure(c.command("slow", [], "s"));
  const quick = failure(c.command("quick", [], "q"));
  await tick(5000);
  await expect(quick).resolves.toEqual({ message: TEXT.timeout, requestId: "q" });
  ws.recv({ t: "ping" }); // 연결은 살아 있다
  await tick(25_000);
  await expect(slow).resolves.toEqual({ message: TEXT.timeout, requestId: "s" });
  // 뒤늦게 온 답은 버린다
  ws.recv({ t: "reply", id: "s", ok: true, result: 1, version: 0 });
  // 연결마다의 timeout
  const t = await fake({ timeout: 1000 });
  const w2 = await t.live();
  w2.recv({ t: "snapshot", version: 0, value: 0 });
  const p = failure(t.c.command("x", [], "t"));
  await t.tick(1000);
  await expect(p).resolves.toEqual({ message: TEXT.timeout, requestId: "t" });
});

it("client: close() 뒤 타이머 · 연결 · 리스너가 남지 않는다", async () => {
  const { c, live } = await fake();
  const ws = await live();
  ws.recv({ t: "snapshot", version: 0, value: 0 });
  const p = failure(c.command("x", []));
  c.close();
  expect(ws.closed).toBeDefined();
  expect(ws.onmessage).toBeNull();
  expect(ws.onclose).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await expect(p).resolves.toMatchObject({ message: TEXT.unknown });
});

it("client: SSE 의 POST 마다 auth() 를 다시 불러 새 토큰을 싣는다 — 연 때의 토큰을 다시 쓰지 않는다", async () => {
  let current = "t1";
  const stream = createStreamServer<number>({
    // 가장 최근 토큰만 받는다 — 신원은 같다
    authorize: (ctx) => (ctx.token === current ? "me" : ctx.reject("낡은 토큰")),
    snapshot: () => 0,
    commands: { ok: () => 1 },
  });
  const s = await serve(stream);
  const c = open<number>({ url: s.url("sse"), transport: "sse", auth: () => current });
  await settled(c);
  current = "t2";
  expect(await c.command("ok", [])).toBe(1);
  current = "t3";
  expect(await c.command("ok", [])).toBe(1);
});
