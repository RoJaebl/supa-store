// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "../stream/protocol.js";
import { createStreamServer, type Conn, type StreamServer } from "./core.js";
import { sseFrame } from "./sse.js";

beforeEach(() => void vi.useFakeTimers({ now: 0 }));
afterEach(() => void vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);

/** 가짜 연결 — 받은 메시지와 닫힘을 남기고, 클라이언트 쪽 메시지를 흘려 넣는다 */
function fakeConn(kind: "ws" | "sse" = "ws", headers: Record<string, string | undefined> = {}) {
  let onMsg: (m: ClientMessage) => void = () => {};
  let onCl = () => {};
  const c = {
    kind,
    headers,
    sent: [] as ServerMessage[],
    closed: undefined as { code: number; reason: string } | undefined,
    send: (m: ServerMessage) => void c.sent.push(m),
    close(code: number, reason: string) {
      c.closed = { code, reason };
      onCl();
    },
    onMessage: (fn: (m: ClientMessage) => void) => void (onMsg = fn),
    onClose: (fn: () => void) => void (onCl = fn),
    emit: (m: ClientMessage) => onMsg(m),
    of: <T extends ServerMessage["t"]>(t: T) => c.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[],
  };
  return c satisfies Conn;
}

/** 붙이고 hello 를 보낸 뒤 welcome 까지 기다린다 */
async function join(s: StreamServer<any, any, any>, hello: Omit<Extract<ClientMessage, { t: "hello" }>, "t"> = {}) {
  const c = fakeConn();
  s.attach(c);
  c.emit({ t: "hello", ...hello });
  await flush();
  return c;
}
const welcomeOf = (c: ReturnType<typeof fakeConn>) => c.of("welcome")[0]!;

it("홉: hello 뒤 welcome{epoch, version, connection} 을 보내고, 버전이 없으면 snapshot 을 보낸다", async () => {
  const s = createStreamServer({ snapshot: () => ["a"] });
  const c = await join(s);
  expect(c.sent).toEqual([
    { t: "welcome", epoch: expect.any(String), version: 0, connection: expect.any(String) },
    { t: "snapshot", version: 0, value: ["a"] },
  ]);
  // 같은 epoch 의 같은 버전이면 따라잡을 것이 없다 — welcome 만
  const d = await join(s, { epoch: welcomeOf(c).epoch, version: 0 });
  expect(d.sent).toEqual([{ t: "welcome", epoch: welcomeOf(c).epoch, version: 0, connection: expect.any(String) }]);
  expect(welcomeOf(d).connection).not.toBe(welcomeOf(c).connection);
  s.close();
});

it("홉: publish 마다 채널 버전을 1씩 올려 붙인 change 를 그 채널의 연결 모두에게 보낸다", async () => {
  let value = 0;
  const s = createStreamServer<number, number>({ snapshot: () => value });
  const a = await join(s);
  const b = await join(s);
  s.publish("default", (value = 1));
  s.publish("default", (value = 2));
  for (const c of [a, b])
    expect(c.of("change")).toEqual([
      { t: "change", version: 1, change: 1 },
      { t: "change", version: 2, change: 2 },
    ]);
  // snapshot 은 부르는 순간의 버전을 붙인다
  const c = await join(s);
  expect(c.of("snapshot")).toEqual([{ t: "snapshot", version: 2, value: 2 }]);
  s.close();
});

it("홉: 같은 epoch 의 기록 안 버전으로 hello 하면 빠진 change 만 차례로 준다", async () => {
  const s = createStreamServer({ snapshot: () => "s" });
  const { epoch } = welcomeOf(await join(s));
  ["x", "y", "z"].forEach((ch) => s.publish("default", ch));
  const c = await join(s, { epoch, version: 1 });
  expect(c.sent).toEqual([
    { t: "welcome", epoch, version: 3, connection: expect.any(String) },
    { t: "change", version: 2, change: "y" },
    { t: "change", version: 3, change: "z" },
  ]);
  s.close();
});

it("홉: 기록 밖 · 다른 epoch 면 snapshot 을 다시 보낸다", async () => {
  const s = createStreamServer({ snapshot: () => "s", history: { count: 2 } });
  const { epoch } = welcomeOf(await join(s));
  ["x", "y", "z"].forEach((ch) => s.publish("default", ch));
  // 기록에는 2 · 3 만 — 0 뒤를 이을 1 이 없다
  expect((await join(s, { epoch, version: 0 })).of("snapshot")).toEqual([{ t: "snapshot", version: 3, value: "s" }]);
  expect((await join(s, { epoch, version: 1 })).of("change").map((m) => m.version)).toEqual([2, 3]);
  // 다른 epoch — 버전이 같아도 보지 않는다
  const other = await join(s, { epoch: "다른 홉", version: 3 });
  expect(other.of("snapshot")).toHaveLength(1);
  expect(other.of("change")).toHaveLength(0);
  // 홉보다 앞선 버전도 기록 밖
  expect((await join(s, { epoch, version: 9 })).of("snapshot")).toHaveLength(1);
  s.close();
});

it("홉: 기록은 1000 개 또는 5분 가운데 짧은 쪽까지만 쥔다", async () => {
  const many = createStreamServer<string, number>({ snapshot: () => "s" });
  const { epoch } = welcomeOf(await join(many));
  for (let i = 1; i <= 1001; i++) many.publish("default", i);
  expect((await join(many, { epoch, version: 0 })).of("snapshot")).toHaveLength(1);
  const caught = await join(many, { epoch, version: 1 });
  expect(caught.of("snapshot")).toHaveLength(0);
  expect(caught.of("change")).toHaveLength(1000);
  many.close();

  const old = createStreamServer({ snapshot: () => "s" });
  const e = welcomeOf(await join(old)).epoch;
  old.publish("default", "a"); // 0초
  await vi.advanceTimersByTimeAsync(200_000);
  old.publish("default", "b"); // 200초
  await vi.advanceTimersByTimeAsync(100_001); // a 는 5분을 넘겼다
  expect((await join(old, { epoch: e, version: 0 })).of("snapshot")).toHaveLength(1);
  expect((await join(old, { epoch: e, version: 1 })).of("change")).toEqual([{ t: "change", version: 2, change: "b" }]);
  old.close();
});

it("홉: command 는 reply{id, ok, result, version} 로 답하고, 같은 id 가 다시 오면 다시 실행하지 않고 쥔 답을 준다", async () => {
  let calls = 0;
  let release = () => {};
  const s: StreamServer<number, number> = createStreamServer<number, number>({
    snapshot: () => 0,
    commands: {
      add: (ctx, n: number) => {
        calls++;
        s.publish(ctx.channel, n);
        return n * 10;
      },
      fail: () => {
        throw new Error("앱의 문구");
      },
      slow: () => new Promise<string>((r) => (release = () => r("늦게"))),
    },
  });
  const c = await join(s);
  c.emit({ t: "command", id: "r1", name: "add", args: [2] });
  await flush();
  c.emit({ t: "command", id: "r1", name: "add", args: [2] });
  await flush();
  expect(calls).toBe(1);
  expect(c.of("reply")).toEqual([
    { t: "reply", id: "r1", ok: true, result: 20, version: 1 },
    { t: "reply", id: "r1", ok: true, result: 20, version: 1 },
  ]);
  c.emit({ t: "command", id: "r2", name: "fail", args: [] });
  c.emit({ t: "command", id: "r3", name: "없는 명령", args: [] });
  await flush();
  expect(c.of("reply").slice(2)).toEqual([
    { t: "reply", id: "r2", ok: false, error: "앱의 문구", version: 1 },
    { t: "reply", id: "r3", ok: false, error: expect.stringContaining("없는 명령"), version: 1 },
  ]);
  // 도는 중에 같은 id 가 다시 와도 한 번만 돌고 둘 다 답을 받는다
  c.emit({ t: "command", id: "r4", name: "slow", args: [] });
  await flush();
  c.emit({ t: "command", id: "r4", name: "slow", args: [] });
  release();
  await flush();
  expect(c.of("reply").filter((m) => m.id === "r4")).toEqual([
    { t: "reply", id: "r4", ok: true, result: "늦게", version: 1 },
    { t: "reply", id: "r4", ok: true, result: "늦게", version: 1 },
  ]);
  s.close();
});

it("홉: ask 는 id 마다 fate(done · unknown-id · running) 로 답한다", async () => {
  const s = createStreamServer({
    snapshot: () => 0,
    commands: { ok: () => "끝", hang: () => new Promise(() => {}) },
  });
  const c = await join(s);
  c.emit({ t: "command", id: "d", name: "ok", args: [] });
  c.emit({ t: "command", id: "h", name: "hang", args: [] });
  await flush();
  // 다시 이은 연결에서 묻는다
  const again = await join(s);
  again.emit({ t: "ask", ids: ["d", "h", "x"] });
  await flush();
  expect(again.of("fate")).toEqual([
    { t: "fate", id: "d", state: "done", ok: true, result: "끝", version: 0 },
    { t: "fate", id: "h", state: "running" },
    { t: "fate", id: "x", state: "unknown-id" },
  ]);
  s.close();
});

it("홉: authorize 가 거절하면 4001 로 닫는다. hello 가 10초 안에 오지 않으면 닫는다", async () => {
  const s = createStreamServer({
    authorize: async (ctx) => (ctx.token === "좋은" ? "나" : ctx.reject("인증 실패")),
    snapshot: (ctx) => ctx.identity,
  });
  const bad = await join(s, { auth: "나쁜" });
  expect(bad.closed).toEqual({ code: 4001, reason: "인증 실패" });
  expect(bad.sent).toEqual([]);
  const good = await join(s, { auth: "좋은" });
  expect(good.of("snapshot")).toEqual([{ t: "snapshot", version: 0, value: "나" }]);

  // hello 전의 다른 메시지는 처리하지 않는다
  const silent = fakeConn();
  s.attach(silent);
  silent.emit({ t: "ask", ids: ["x"] });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(silent.sent).toEqual([]);
  expect(silent.closed).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(silent.closed?.code).toBe(4000);
  s.close();
});

it("홉: 25초마다 ping 을 보낸다", async () => {
  const s = createStreamServer({ snapshot: () => 0 });
  const c = await join(s);
  await vi.advanceTimersByTimeAsync(24_999);
  expect(c.of("ping")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(25_001);
  expect(c.of("ping")).toHaveLength(2);
  c.close(1000, "");
  await vi.advanceTimersByTimeAsync(100_000);
  expect(c.of("ping")).toHaveLength(2);
  s.close();
});

it("홉: ctx.request 는 클라이언트의 answer 로 풀리고, 30초 안에 오지 않으면 응답 지연으로 거절한다", async () => {
  const s = createStreamServer({
    snapshot: () => 0,
    commands: { confirm: (ctx, q: string) => ctx.request("confirm", [q]) },
  });
  const c = await join(s);
  c.emit({ t: "command", id: "r1", name: "confirm", args: ["지울까?"] });
  await flush();
  const [req] = c.of("request");
  expect(req).toEqual({ t: "request", id: expect.any(String), method: "confirm", params: ["지울까?"] });
  c.emit({ t: "answer", id: req!.id, ok: true, result: "예" });
  await flush();
  expect(c.of("reply")).toEqual([{ t: "reply", id: "r1", ok: true, result: "예", version: 0 }]);

  c.emit({ t: "command", id: "r2", name: "confirm", args: ["또?"] });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(c.of("reply")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(c.of("reply")[1]).toEqual({ t: "reply", id: "r2", ok: false, error: "응답 지연", version: 0 });

  // 클라이언트가 실패로 답하면 그 문구로 거절한다
  c.emit({ t: "command", id: "r3", name: "confirm", args: ["셋"] });
  await flush();
  c.emit({ t: "answer", id: c.of("request")[2]!.id, ok: false, error: "핸들러 없음" });
  await flush();
  expect(c.of("reply")[2]).toMatchObject({ id: "r3", ok: false, error: "핸들러 없음" });
  s.close();
});

it("홉: snapshot 이 던지면 그 연결만 4000 으로 닫고 다른 연결과 publish 는 산다", async () => {
  const s = createStreamServer<string, number>({
    snapshot: (ctx) => {
      if (ctx.channel === "boom") throw new Error("터짐");
      return "s";
    },
  });
  const bad = await join(s, { channel: "boom" });
  expect(bad.closed?.code).toBe(4000);
  const good = await join(s);
  expect(() => s.publish("boom", 1)).not.toThrow();
  s.publish("default", 2);
  expect(bad.of("change")).toHaveLength(0);
  expect(good.of("change")).toEqual([{ t: "change", version: 1, change: 2 }]);
  expect(good.closed).toBeUndefined();
  s.close();
});

it("홉: 채널마다 버전 · 기록 · 답 기록이 따로다", async () => {
  let calls = 0;
  const s = createStreamServer<number, string>({ snapshot: () => 0, commands: { hit: () => ++calls } });
  const { epoch } = welcomeOf(await join(s, { channel: "a" }));
  s.publish("a", "a1");
  s.publish("a", "a2");
  s.publish("b", "b1");
  const b = await join(s, { channel: "b", epoch, version: 0 });
  expect(welcomeOf(b).version).toBe(1);
  expect(b.of("change")).toEqual([{ t: "change", version: 1, change: "b1" }]);
  const a = await join(s, { channel: "a" });
  a.emit({ t: "command", id: "same", name: "hit", args: [] });
  b.emit({ t: "command", id: "same", name: "hit", args: [] });
  await flush();
  expect(calls).toBe(2);
  expect(a.of("reply")[0]).toMatchObject({ result: 1, version: 2 });
  expect(b.of("reply")[0]).toMatchObject({ result: 2, version: 1 });
  s.close();
});

it("홉: channel 함수가 신원으로 채널을 정한다", async () => {
  const s = createStreamServer({
    authorize: (ctx) => ctx.token!,
    channel: (ctx) => `user:${ctx.identity}`,
    snapshot: (ctx) => ctx.channel,
  });
  const c = await join(s, { auth: "kim", channel: "무시된다" });
  expect(c.of("snapshot")[0]?.value).toBe("user:kim");
  s.close();
});

it("홉: close 하면 모든 연결을 4000 으로 닫고 타이머를 걷는다", async () => {
  const s = createStreamServer({ snapshot: () => 0 });
  const c = await join(s);
  s.close();
  expect(c.closed?.code).toBe(4000);
  expect(vi.getTimerCount()).toBe(0);
});

it("SSE: 헤더가 hello 를 대신한다 — Authorization · X-Supa-Channel · X-Supa-Epoch · Last-Event-ID", async () => {
  const s = createStreamServer<unknown, string, string | undefined>({ authorize: (ctx) => ctx.token, snapshot: (ctx) => [ctx.identity, ctx.channel] });
  const first = fakeConn("sse", { authorization: "Bearer kim", "x-supa-channel": "c" });
  s.attach(first);
  await flush();
  expect(first.of("snapshot")).toEqual([{ t: "snapshot", version: 0, value: ["kim", "c"] }]);
  s.publish("c", "x");
  s.publish("c", "y");
  const epoch = welcomeOf(first).epoch;
  const again = fakeConn("sse", { authorization: "Bearer kim", "x-supa-channel": "c", "x-supa-epoch": epoch, "last-event-id": "1" });
  s.attach(again);
  await flush();
  expect(again.sent.slice(1)).toEqual([{ t: "change", version: 2, change: "y" }]);
  // SSE 는 hello 를 기다리지 않으므로 10초 뒤에도 닫지 않는다
  await vi.advanceTimersByTimeAsync(10_000);
  expect(again.closed).toBeUndefined();
  s.close();
});

it("SSE: POST 는 X-Supa-Connection 의 연결로 묶이고 authorize 를 다시 부른다 — 신원이나 채널이 다르면 403", async () => {
  let authorized = 0;
  const s = createStreamServer({
    authorize: (ctx) => (authorized++, ctx.token === "거절" ? ctx.reject("인증 실패") : ctx.token),
    snapshot: () => 0,
    commands: { echo: (ctx, v: string) => `${ctx.identity}:${v}`, ask: (ctx) => ctx.request("pick", []) },
  });
  const conn = fakeConn("sse", { authorization: "Bearer kim" });
  s.attach(conn);
  await flush();
  const id = welcomeOf(conn).connection;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    s.handlePost({ headers: { authorization: "Bearer kim", "x-supa-connection": id, ...headers }, body: JSON.stringify(body) });

  const before = authorized;
  expect(await post({ t: "command", id: "r1", name: "echo", args: ["hi"] })).toEqual({
    status: 200,
    body: { t: "reply", id: "r1", ok: true, result: "kim:hi", version: 0 },
  });
  expect(authorized).toBe(before + 1);
  expect(await post({ t: "ask", ids: ["r1", "zz"] })).toEqual({
    status: 200,
    body: [
      { t: "fate", id: "r1", state: "done", ok: true, result: "kim:hi", version: 0 },
      { t: "fate", id: "zz", state: "unknown-id" },
    ],
  });
  // 서버의 request 는 스트림으로 가고 answer 는 POST 로 온다
  const pending = post({ t: "command", id: "r2", name: "ask", args: [] });
  await flush();
  const req = conn.of("request")[0]!;
  expect(await post({ t: "answer", id: req.id, ok: true, result: 7 })).toEqual({ status: 204, body: null });
  expect((await pending).body).toMatchObject({ id: "r2", ok: true, result: 7 });

  expect((await post({ t: "command", id: "r3", name: "echo", args: [] }, { authorization: "Bearer lee" })).status).toBe(403);
  expect((await post({ t: "command", id: "r3", name: "echo", args: [] }, { "x-supa-channel": "other" })).status).toBe(403);
  expect((await post({ t: "command", id: "r3", name: "echo", args: [] }, { authorization: "Bearer 거절" })).status).toBe(401);
  expect((await post({ t: "command", id: "r3", name: "echo", args: [] }, { "x-supa-connection": "없음" })).status).toBe(404);
  expect((await s.handlePost({ headers: { "x-supa-connection": id }, body: "{깨짐" })).status).toBe(400);
  expect((await post({ t: "hello" })).status).toBe(400);
  s.close();
});

it("sseFrame: 메시지 하나를 data: 한 줄 JSON 으로 쓰고, snapshot · change 에는 id: 버전을 붙인다", () => {
  expect(sseFrame({ t: "change", version: 3, change: { a: 1 } })).toBe('id: 3\ndata: {"t":"change","version":3,"change":{"a":1}}\n\n');
  expect(sseFrame({ t: "snapshot", version: 0, value: "줄\n바꿈" })).toBe('id: 0\ndata: {"t":"snapshot","version":0,"value":"줄\\n바꿈"}\n\n');
  expect(sseFrame({ t: "ping" })).toBe('data: {"t":"ping"}\n\n');
});
