// jsdom — renderHook 이 document 를 쓴다. Node 의 전역 WebSocket(undici)은 jsdom 의 Event 를 받지 못해 던지므로
// 이 파일만 ws 의 WebSocket 으로 실제 서버에 붙는다(SSE 와 웹소켓의 차이는 client.test.ts 가 node 에서 본다)
import { act, renderHook, waitFor } from "@testing-library/react";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { WebSocket as Ws } from "ws";
import { createStore, disposeStores, getStore, overrideStore, resetStores, type DISPOSE } from "../index.js";
import type { MutationView } from "../query.js";
import { useStore } from "../react.js";
import { createStreamServer, type StreamServer } from "../server/core.js";
import { attachStream } from "../server/node.js";
import { TIMING } from "./client.js";
import { NO_FAILURE } from "./hook.js";
import { createStream, type Stream, type StreamCommandView } from "./index.js";
import { TEXT } from "./protocol.js";

// ws 는 연결 전에 닫으면 error 를 내고, 듣는 이가 없으면 던진다 — 브라우저처럼 조용히 둔다
class Quiet extends Ws {
  constructor(...args: ConstructorParameters<typeof Ws>) {
    super(...args);
    this.on("error", () => {});
  }
}
globalThis.WebSocket = Quiet as unknown as typeof WebSocket;

const PATH = "/s";
const GAP = 20;
let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  disposeStores();
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  vi.unstubAllGlobals();
});

/** 실제 http 서버에 홉을 붙인다 — sockets 는 지금 열린 TCP 연결(웹소켓 하나가 하나) */
async function serve(stream: StreamServer<any, any, any>) {
  const server = http.createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const detach = attachStream(server, { path: PATH, stream });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  cleanup.push(() => {
    detach();
    stream.close();
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return { url: `ws://127.0.0.1:${port}${PATH}`, port, sockets, kill: () => sockets.forEach((s) => s.destroy()) };
}

let n = 0;
/** 연결 store 를 등록한다 — 다시 잇기 첫 간격을 줄인다 */
function define(o: object): string {
  const key = `api.stream.s${++n}`;
  createStore(key, () => createStream({ [TIMING]: GAP, open: "always", ...o } as never));
  return key;
}
const view = (key: string, options?: object): any => (useStore as any)(key, options);
const state = (key: string): any => getStore(key as never).getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 그린 결과를 모두 남긴다 — 다시 잇기가 빨라 지나간 상태를 waitFor 가 놓치지 않게 */
function rendered(key: string, options?: object) {
  const seen: any[] = [];
  const hook = renderHook(() => {
    const v = view(key, options);
    seen.push(v);
    return v;
  });
  return { ...hook, seen };
}

/** 명령 add 는 값에 더해 바뀜을 내고 대문자로 답한다. bad 는 앱이 ok: false 로 답한다 */
const adder = () => {
  const all: string[] = [];
  const stream: StreamServer<string[], string> = createStreamServer<string[], string>({
    snapshot: () => [...all],
    commands: {
      add: (ctx, v: string) => (all.push(v), stream.publish(ctx.channel, v), v.toUpperCase()),
      bad: () => {
        throw new Error("앱이 거절했다");
      },
    },
  });
  return stream;
};
const reduce = (v: string[], c: string) => [...v, c];

// ── 타입 ──────────────────────────────────────────────

type Cmd = { add(v: string): string; kill(id: number): void };
const typed = () => createStream<string[], string, Cmd>({ url: "ws://x", reduce, commands: { add: {}, kill: { timeout: 5 } } });
declare module "../index.js" {
  interface StateTypes {
    "api.types.stream": ReturnType<typeof typed>;
  }
}
it("타입: 고른 칸과 명령의 MutationView · retry, store 끼리의 명령 함수", () => {
  expectTypeOf<ReturnType<typeof typed>>().toEqualTypeOf<Stream<string[], Cmd>>();
  expectTypeOf<ReturnType<typeof typed>[typeof DISPOSE]>().toEqualTypeOf<() => void>();
  expectTypeOf<ReturnType<typeof typed>["add"]>().toEqualTypeOf<(v: string) => Promise<string>>();
  // 부르지 않는다 — 훅 바깥이라 타입만 본다
  const picked = () => useStore("api.types.stream", { pick: ["data", "status", "add"] });
  type P = ReturnType<typeof picked>;
  expectTypeOf<keyof P>().toEqualTypeOf<"data" | "status" | "add">();
  expectTypeOf<P["data"]>().toEqualTypeOf<string[] | undefined>();
  expectTypeOf<P["add"]>().toEqualTypeOf<StreamCommandView<Cmd["add"]>>();
  expectTypeOf<P["add"]>().toMatchTypeOf<MutationView<Cmd["add"]>>();
  expectTypeOf<P["add"]["retry"]>().toEqualTypeOf<() => Promise<string>>();
  const all = () => useStore("api.types.stream");
  expectTypeOf<ReturnType<typeof all>["isFetching"]>().toEqualTypeOf<boolean>();
  expectTypeOf<ReturnType<typeof all>["kill"]["mutateAsync"]>().toEqualTypeOf<(id: number) => Promise<void>>();
  const omitted = () => useStore("api.types.stream", { omit: ["kill", "error"] });
  expectTypeOf<keyof ReturnType<typeof omitted>>().toEqualTypeOf<"data" | "status" | "isFetching" | "add">();
  // @ts-expect-error 없는 칸은 고르지 못한다
  () => useStore("api.types.stream", { pick: ["nope"] });
  // @ts-expect-error 명령마다 옵션을 적어야 이름이 런타임에 남는다
  () => createStream<string[], string, Cmd>({ url: "ws://x", commands: { add: {} } });
});

// ── 화면 ──────────────────────────────────────────────

it("stream: useStore 로 data · status · isFetching · error 와 명령을 꺼낸다", async () => {
  const stream = adder();
  const s = await serve(stream);
  const key = define({ url: s.url, reduce, commands: { add: {} } });
  const { result, seen } = rendered(key);
  expect(result.current).toMatchObject({ data: undefined, status: "loading", isFetching: true, error: null });
  expect(Object.keys(result.current).sort()).toEqual(["add", "data", "error", "isFetching", "status"]);
  await waitFor(() => expect(result.current).toMatchObject({ data: [], status: "ready", isFetching: false, error: null }));
  await act(() => result.current.add.mutateAsync("a"));
  expect(result.current.data).toEqual(["a"]);
  // 끊기면 마지막 값을 쥔 채 재시도 중
  const before = seen.length;
  s.kill();
  await waitFor(() => expect(seen.length).toBeGreaterThan(before + 1));
  await waitFor(() => expect(result.current).toMatchObject({ isFetching: false, error: null }));
  expect(seen.slice(before)).toContainEqual(
    expect.objectContaining({ data: ["a"], status: "ready", isFetching: true, error: TEXT.reconnecting }),
  );
});

it("stream: pick 한 칸이 바뀔 때만 다시 그린다 — isFetching 만 바뀌면 data 화면은 그대로", async () => {
  const stream = adder();
  const s = await serve(stream);
  const key = define({ url: s.url, reduce, commands: { add: {} } });
  const data = rendered(key, { pick: ["data"] });
  const fetching = rendered(key, { pick: ["isFetching"] });
  await waitFor(() => expect(fetching.result.current.isFetching).toBe(false));
  expect(Object.keys(data.result.current)).toEqual(["data"]);
  const shown = data.result.current;
  const [d0, f0] = [data.seen.length, fetching.seen.length];
  s.kill();
  await waitFor(() => expect(fetching.seen.length).toBeGreaterThan(f0 + 1));
  await waitFor(() => expect(fetching.result.current.isFetching).toBe(false));
  expect(fetching.seen.slice(f0)).toContainEqual({ isFetching: true });
  expect(data.seen.length).toBe(d0);
  expect(data.result.current).toBe(shown);
  // data 가 바뀌면 그린다
  await act(() => state(key).add("b"));
  expect(data.result.current.data).toEqual(["b"]);
});

it("stream: 명령의 mutate · mutateAsync · pending · error · data 가 0.2 와 같다", async () => {
  const stream = adder();
  const s = await serve(stream);
  const key = define({ url: s.url, reduce, commands: { add: {}, bad: {} } });
  const { result } = renderHook(() => view(key, { pick: ["add", "bad"] }));
  await waitFor(() => expect(state(key)).toBeDefined());
  await act(() => sleep(GAP * 5)); // 이어질 때까지
  expect(result.current.add).toMatchObject({ pending: false, error: null, data: undefined });
  let done!: Promise<unknown>;
  act(() => void (done = result.current.add.mutateAsync("a")));
  expect(result.current.add.pending).toBe(true);
  await act(async () => expect(await done).toBe("A"));
  expect(result.current.add).toMatchObject({ pending: false, error: null, data: "A" });
  // mutate 는 아무것도 돌려주지 않고 실패는 error 에만
  act(() => expect(result.current.bad.mutate()).toBeUndefined());
  await waitFor(() => expect(result.current.bad).toMatchObject({ pending: false, error: "앱이 거절했다" }));
  await act(() => expect(result.current.bad.mutateAsync()).rejects.toThrow("앱이 거절했다"));
  act(() => result.current.add.reset());
  expect(result.current.add).toMatchObject({ pending: false, error: null, data: undefined });
});

it("stream: retry() 는 마지막 실패를 같은 요청 id 로 다시 보내고, 서버는 두 번 실행하지 않는다. 실패가 없으면 거절한다", async () => {
  const ran: string[] = [];
  let bad = 0;
  const stream = createStreamServer<number>({
    snapshot: () => 0,
    commands: {
      // 제한 시간보다 늦게 답한다 — 화면은 「응답 지연」으로 실패하고 홉은 답을 쥔다
      slow: async (_ctx, v: string) => (ran.push(v), await sleep(150), v.toUpperCase()),
      bad: () => {
        bad++;
        throw new Error("앱이 거절했다");
      },
    },
  });
  const s = await serve(stream);
  const key = define({ url: s.url, commands: { slow: { timeout: 50 }, bad: {} } });
  const { result } = renderHook(() => view(key, { pick: ["status", "slow", "bad"] }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(() => expect(result.current.slow.retry()).rejects.toThrow("다시 보낼 실패한 명령이 없다"));
  await act(() => expect(result.current.slow.mutateAsync("a")).rejects.toThrow(TEXT.timeout));
  expect(result.current.slow.error).toBe(TEXT.timeout);
  await act(() => sleep(150)); // 홉이 답을 냈다
  await act(async () => expect(await result.current.slow.retry()).toBe("A"));
  expect(result.current.slow).toMatchObject({ pending: false, error: null, data: "A" });
  expect(ran).toEqual(["a"]);
  // 다시 보낸 것이 풀렸으니 다시 보낼 실패가 없다
  await act(() => expect(result.current.slow.retry()).rejects.toThrow("다시 보낼 실패한 명령이 없다"));
  // 앱의 ok: false 는 같은 id 로 다시 보내도 같은 실패 — 홉은 다시 돌리지 않는다
  await act(() => expect(result.current.bad.mutateAsync()).rejects.toThrow("앱이 거절했다"));
  await act(() => expect(result.current.bad.retry()).rejects.toThrow("앱이 거절했다"));
  expect(bad).toBe(1);
});

it("stream: 쥔 실패는 그 명령 칸의 뒤이은 성공(mutate · mutateAsync)과 reset() 이 지운다", async () => {
  let ran = 0;
  const stream = createStreamServer<number>({
    snapshot: () => 0,
    commands: {
      flaky: (_ctx, ok: boolean) => {
        ran++;
        if (!ok) throw new Error("앱이 거절했다");
        return "ok";
      },
    },
  });
  const s = await serve(stream);
  const key = define({ url: s.url, commands: { flaky: {} } });
  const { result } = renderHook(() => view(key, { pick: ["status", "flaky"] }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  // 실패 뒤 mutateAsync 의 성공
  await act(() => expect(result.current.flaky.mutateAsync(false)).rejects.toThrow("앱이 거절했다"));
  await act(async () => expect(await result.current.flaky.mutateAsync(true)).toBe("ok"));
  await act(() => expect(result.current.flaky.retry()).rejects.toThrow(NO_FAILURE));
  // 실패 뒤 mutate 의 성공
  await act(() => expect(result.current.flaky.mutateAsync(false)).rejects.toThrow("앱이 거절했다"));
  act(() => result.current.flaky.mutate(true));
  await waitFor(() => expect(result.current.flaky).toMatchObject({ pending: false, data: "ok" }));
  await act(() => expect(result.current.flaky.retry()).rejects.toThrow(NO_FAILURE));
  // 실패 뒤 reset
  await act(() => expect(result.current.flaky.mutateAsync(false)).rejects.toThrow("앱이 거절했다"));
  act(() => result.current.flaky.reset());
  await act(() => expect(result.current.flaky.retry()).rejects.toThrow(NO_FAILURE));
  expect(ran).toBe(5);
});

it("stream: store 끼리는 ctx(key).open(...) 으로 부르고 실패하면 던진다", async () => {
  const stream = adder();
  const s = await serve(stream);
  const key = define({ url: s.url, reduce, commands: { add: {}, bad: {} } });
  const user = `api.stream.user${++n}`;
  createStore(user, (_set, _get, ctx) => ({
    add: (v: string) => (ctx as any)(key).add(v),
    bad: () => (ctx as any)(key).bad(),
  }));
  state(key); // 연다
  await act(() => sleep(GAP * 5));
  await expect(state(user).add("x")).resolves.toBe("X");
  await expect(state(user).bad()).rejects.toThrow("앱이 거절했다");
  await expect(state(user).bad()).rejects.toHaveProperty("requestId");
});

it("stream: overrideStore · resetStores 로 다시 지으면 앞 연결이 닫히고 새로 하나만 열린다 — 열 번 다시 지어도 서버의 연결은 하나", async () => {
  const stream = adder();
  const s = await serve(stream);
  const key = define({ url: s.url, reduce, commands: { add: {} } });
  const { result } = renderHook(() => view(key, { pick: ["data", "isFetching"] }));
  await waitFor(() => expect(result.current.isFetching).toBe(false));
  await act(() => state(key).add("a"));
  expect(s.sockets.size).toBe(1);
  act(() => {
    for (let i = 0; i < 5; i++) resetStores();
    for (let i = 0; i < 5; i++)
      overrideStore(key as never, () =>
        createStream({ [TIMING]: GAP, open: "always", url: s.url, reduce, commands: { add: {} } } as never),
      );
  });
  await waitFor(() => expect(s.sockets.size).toBe(1));
  // 새 연결의 값이 화면에 온다 — 앞 연결의 늦은 메시지는 새 store 를 고치지 않는다
  await waitFor(() => expect(result.current).toEqual({ data: ["a"], isFetching: false }));
  await act(() => sleep(GAP * 10));
  expect(s.sockets.size).toBe(1);
});

it("stream: disposeStores 뒤 연결 · 타이머가 남지 않는다", async () => {
  let hellos = 0;
  const stream = createStreamServer<number>({ authorize: () => void hellos++, snapshot: () => 0 });
  const s = await serve(stream);
  const key = define({ url: s.url });
  const { result } = renderHook(() => view(key, { pick: ["status"] }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  // 끊긴 채 다시 잇기 타이머가 걸린 때 닫는다
  s.kill();
  act(() => disposeStores());
  await waitFor(() => expect(s.sockets.size).toBe(0));
  const seen = hellos;
  await sleep(GAP * 10); // 다시 잇는다면 첫 간격 ±20% 안에 다시 온다
  expect(hellos).toBe(seen);
  expect(s.sockets.size).toBe(0);
});

it("stream: window 가 없으면 열지 않고, open: \"always\" 면 연다", async () => {
  let hellos = 0;
  const stream = createStreamServer<number>({ authorize: () => void hellos++, snapshot: () => 0, commands: { x: () => 1 } });
  const s = await serve(stream);
  const browser = `api.stream.b${++n}`;
  const always = `api.stream.a${++n}`;
  createStore(browser, () => createStream({ [TIMING]: GAP, url: s.url, commands: { x: {} } } as never));
  createStore(always, () => createStream({ [TIMING]: GAP, url: s.url, open: "always" } as never));
  vi.stubGlobal("window", undefined);
  state(browser);
  state(always);
  vi.unstubAllGlobals();
  await sleep(GAP * 10);
  expect(hellos).toBe(1);
  const { result } = renderHook(() => view(browser, { pick: ["data", "status", "isFetching", "error"] }));
  expect(result.current).toEqual({ data: undefined, status: "loading", isFetching: true, error: null });
  await expect(state(browser).x()).rejects.toThrow(TEXT.commandFailed);
});

it("stream: 상대 주소는 location 으로 푼다 — 없으면 createStream 이 던진다", async () => {
  const stream = createStreamServer<number>({ snapshot: () => 7 });
  const s = await serve(stream);
  vi.stubGlobal("location", new URL(`http://127.0.0.1:${s.port}/app/page`));
  const key = define({ url: PATH });
  const { result } = renderHook(() => view(key, { pick: ["data"] }));
  await waitFor(() => expect(result.current.data).toBe(7));
  vi.stubGlobal("location", undefined);
  expect(() => createStream({ url: PATH, open: "always" })).toThrow(/상대 주소/);
});

it("stream: URL.canParse 가 없는 브라우저에서도 절대 주소를 그대로 쓴다", async () => {
  const stream = createStreamServer<number>({ snapshot: () => 3 });
  const s = await serve(stream);
  const canParse = URL.canParse;
  // @ts-expect-error 옛 브라우저 흉내
  delete URL.canParse;
  cleanup.push(() => void (URL.canParse = canParse));
  const key = define({ url: s.url });
  const { result } = renderHook(() => view(key, { pick: ["data"] }));
  await waitFor(() => expect(result.current.data).toBe(3));
});
