// @vitest-environment node
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, disposeStores, DISPOSE, getStore, resetStores } from "../index.js";
import { TIMING, type ClientView } from "../stream/client.js";
import { TEXT } from "../stream/protocol.js";
import { createJsonRpc, type JsonRpcOptions } from "./client.js";
import type { Transport } from "./transport.js";

type Sent = { id?: number; method: string; params?: unknown };

/** connect 마다 새로 짓는 가짜 통로 — 보낸 것은 sent, 받기 · 닫힘은 손으로 */
type Fake = {
  t: Transport;
  sent: Sent[];
  end(r?: Error): void;
  receive(m: object): void;
  reply(method: string, result: unknown): void;
};
const fakes: Fake[] = [];
const fake = (): Fake => {
  const sent: Sent[] = [];
  let message = (_: string) => {};
  let close = (_?: Error) => {};
  let ended = false;
  const end = (r?: Error) => {
    if (ended) return;
    ended = true;
    close(r);
  };
  const t: Transport = {
    send: (m) => void (ended || sent.push(JSON.parse(m))),
    onMessage: (fn) => void (message = fn),
    onClose: (fn) => void (close = fn),
    close: vi.fn(() => end()),
  };
  const f: Fake = {
    t,
    sent,
    end,
    receive: (m: object) => message(JSON.stringify({ jsonrpc: "2.0", ...m })),
    /** 보낸 요청 중 method 가 맞는 마지막 것에 답한다 */
    reply: (method: string, result: unknown) => f.receive({ id: f.sent.filter((s) => s.method === method).pop()!.id, result }),
  };
  fakes.push(f);
  return f;
};
const connect = () => fake().t;
const last = () => fakes[fakes.length - 1]!;
const methods = (f = last()) => f.sent.map((s) => s.method);

/** 다시 잇기 첫 간격 10ms · 흔들림 없음 */
const GAP = 10;
const timing = { [TIMING]: GAP } as {};
const flush = () => vi.advanceTimersByTimeAsync(0);

/** onConnect 를 손으로 끝낸다 */
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

type V = { n: number[] };
type Note = { method: "add"; params: number };
type Cmd = { echo: (p: string) => string; slow: (p: number) => number };
type Out = { ping: number };
const base = (o: Partial<JsonRpcOptions<V, Note, Cmd, Out>> = {}) =>
  createJsonRpc<V, Note, Cmd, Out>({
    connect,
    reduce: (v, n) => ({ n: [...v.n, n.params] }),
    requests: { echo: { method: "echo" }, slow: { method: "slow", timeout: 100 } },
    notifications: { ping: "ping" },
    ...timing,
    ...o,
  });

const closing: { close(): void }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  closing.splice(0).forEach((c) => c.close());
  fakes.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const keep = <T extends { close(): void }>(c: T) => (closing.push(c), c);

describe("연결 상태", () => {
  it("처음 → 준비 → 끊김 → 다시 준비. 바뀌지 않았으면 같은 객체", async () => {
    let d = deferred<V>();
    const onConnect = vi.fn(() => d.promise);
    const rpc = keep(base({ onConnect }));
    const first = rpc.view();
    expect(first).toEqual({ data: undefined, status: "loading", isFetching: true, error: null });
    expect(rpc.view()).toBe(first);
    expect(onConnect).toHaveBeenCalledWith(undefined, expect.anything());

    const seen = vi.fn();
    rpc.subscribe(seen);
    d.resolve({ n: [1] });
    await flush();
    expect(rpc.view()).toEqual({ data: { n: [1] }, status: "ready", isFetching: false, error: null });
    expect(seen).toHaveBeenCalledTimes(1);

    const f0 = last();
    d = deferred<V>();
    f0.end();
    expect(f0.t.close).toHaveBeenCalled(); // 스스로 닫힌 통로도 닫는다 — stdio 가 살아 있는 자식을 거둔다
    const broken = rpc.view();
    expect(broken).toEqual({ data: { n: [1] }, status: "ready", isFetching: true, error: TEXT.reconnecting });

    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(fakes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes).toHaveLength(2);
    expect(onConnect).toHaveBeenLastCalledWith({ n: [1] }, expect.anything());
    expect(rpc.view()).toBe(broken); // onConnect 가 도는 동안도 재시도 중

    d.resolve({ n: [1, 2] });
    await flush();
    expect(rpc.view()).toEqual({ data: { n: [1, 2] }, status: "ready", isFetching: false, error: null });
  });

  it("onConnect 가 없으면 열리자마자 준비되고 data 는 undefined", () => {
    const rpc = keep(base());
    expect(rpc.view()).toEqual({ data: undefined, status: "ready", isFetching: false, error: null });
    expect(rpc.ping(1)).toBe(true);
  });

  it("준비되면 다시 잇기 간격이 처음으로 돌아간다", async () => {
    const rpc = keep(base());
    last().end();
    await vi.advanceTimersByTimeAsync(GAP);
    last().end();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(fakes).toHaveLength(3);
    expect(rpc.view().error).toBeNull();
  });
});

describe("준비 문", () => {
  it("준비 전 요청은 onConnect 뒤 부른 순서로 나가고, onConnect 의 rpc.request 는 곧바로 나간다", async () => {
    const d = deferred<V>();
    const rpc = keep(
      base({
        onConnect: async (_last, r) => {
          await r.request("initialize", { a: 1 });
          r.notify("initialized");
          return d.promise;
        },
      }),
    );
    const a = rpc.echo("a");
    const b = rpc.request("raw", [1]);
    expect(methods()).toEqual(["initialize"]);
    last().reply("initialize", {});
    await flush();
    expect(methods()).toEqual(["initialize", "initialized"]);
    d.resolve({ n: [] });
    await flush();
    expect(methods()).toEqual(["initialize", "initialized", "echo", "raw"]);
    expect(last().sent[2]).toMatchObject({ method: "echo", params: "a" });
    last().reply("echo", "A");
    last().reply("raw", "R");
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("R");
  });

  it("제한 시간은 부른 때부터 센다 — 준비를 기다리다 지나면 응답 지연이고 나가지 않는다", async () => {
    const d = deferred<V>();
    const rpc = keep(base({ onConnect: () => d.promise }));
    const slow = rpc.slow(1).catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await slow).toMatchObject({ message: TEXT.timeout });
    d.resolve({ n: [] });
    await flush();
    expect(methods()).toEqual([]);
  });

  it("준비 전에 기다린 시간도 센다 — 남은 시간이 지나면 응답 지연", async () => {
    const d = deferred<V>();
    const rpc = keep(base({ onConnect: () => d.promise }));
    const slow = rpc.slow(1).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60);
    d.resolve({ n: [] });
    await flush();
    expect(methods()).toEqual(["slow"]);
    await vi.advanceTimersByTimeAsync(40);
    expect(await slow).toMatchObject({ message: TEXT.timeout });
  });

  it("준비 전 알림은 처음과 다시 모두 버리고 false, 준비 뒤엔 true 이고 요청과 부른 순서로 나간다", async () => {
    let d = deferred<V>();
    const rpc = keep(base({ onConnect: () => d.promise }));
    expect(rpc.ping(1)).toBe(false);
    expect(rpc.notify("raw")).toBe(false);
    d.resolve({ n: [] });
    await flush();
    expect(methods()).toEqual([]);

    expect(rpc.ping(2)).toBe(true);
    void rpc.echo("x").catch(() => {});
    expect(rpc.notify("raw", { y: 1 })).toBe(true);
    expect(last().sent).toMatchObject([
      { method: "ping", params: 2 },
      { method: "echo", params: "x" },
      { method: "raw", params: { y: 1 } },
    ]);

    d = deferred<V>();
    last().end();
    expect(rpc.ping(3)).toBe(false);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(rpc.ping(4)).toBe(false); // 다시 이은 뒤 onConnect 도중
    d.resolve({ n: [] });
    await flush();
    expect(methods()).toEqual([]);
  });

  it("onConnect 도중 온 알림은 돌려준 값 위에 받은 순서대로 reduce 된다", async () => {
    const d = deferred<V>();
    const rpc = keep(base({ onConnect: () => d.promise }));
    last().receive({ method: "add", params: 1 });
    last().receive({ method: "add", params: 2 });
    expect(rpc.view().data).toBeUndefined();
    d.resolve({ n: [0] });
    await flush();
    expect(rpc.view().data).toEqual({ n: [0, 1, 2] });
    last().receive({ method: "add", params: 3 });
    expect(rpc.view().data).toEqual({ n: [0, 1, 2, 3] });
  });
});

describe("다시 잇기", () => {
  it("connect 가 던지거나 거절하면 그 문구가 error 에 실리고 간격대로 다시 부른다", async () => {
    let n = 0;
    const rpc = keep(
      base({
        connect: () => {
          n++;
          if (n === 1) throw new Error("없다");
          if (n === 2) return Promise.reject(new Error("거절"));
          return fake().t;
        },
      }),
    );
    expect(rpc.view()).toEqual({ data: undefined, status: "loading", isFetching: true, error: "없다" });
    await vi.advanceTimersByTimeAsync(GAP);
    expect(n).toBe(2);
    expect(rpc.view().error).toBe("거절");
    await vi.advanceTimersByTimeAsync(GAP * 2 - 1);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(3);
    expect(rpc.view()).toEqual({ data: undefined, status: "ready", isFetching: false, error: null });
  });

  it("통로의 onMessage 등록이 던져도 처리되지 않은 거절 없이 그 문구가 error 에 실리고 다시 시도한다", async () => {
    let n = 0;
    const rpc = keep(
      base({
        connect: () => {
          if (n++) return fake().t;
          const t = fake().t;
          t.onMessage = () => {
            throw new Error("등록 실패");
          };
          return Promise.resolve(t);
        },
      }),
    );
    await flush();
    expect(rpc.view().error).toBe("등록 실패");
    await vi.advanceTimersByTimeAsync(GAP);
    expect(n).toBe(2);
    expect(rpc.view().status).toBe("ready");
  });

  it("onConnect 안의 요청 뒤 통로가 닫히면 알 수 없음으로 끝나고 다시 잇는다", async () => {
    let caught: unknown;
    const rpc = keep(
      base({
        onConnect: async (_l, r) => {
          await r.request("initialize").catch((e) => {
            caught = e;
            throw e;
          });
          return { n: [] };
        },
      }),
    );
    last().end();
    await flush();
    expect(caught).toMatchObject({ message: TEXT.unknown });
    expect(rpc.view().error).toBe(TEXT.reconnecting);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(fakes).toHaveLength(2);
  });

  it("onConnect 가 던지면 그 통로를 닫고 끊긴 것으로 다시 잇는다", async () => {
    let n = 0;
    const rpc = keep(
      base({
        onConnect: () => {
          if (++n === 1) throw new Error("맞춤 실패");
          return { n: [] };
        },
      }),
    );
    await flush();
    expect(fakes[0]!.t.close).toHaveBeenCalled();
    expect(rpc.view()).toMatchObject({ isFetching: true, error: TEXT.reconnecting });
    await vi.advanceTimersByTimeAsync(GAP);
    await flush();
    expect(rpc.view()).toEqual({ data: { n: [] }, status: "ready", isFetching: false, error: null });
  });
});

describe("고침 1", () => {
  it("쌓인 알림의 reduce 가 던지면 그 하나만 건너뛰고 준비된다", async () => {
    const d = deferred<V>();
    const rpc = keep(
      base({
        onConnect: () => d.promise,
        reduce: (v, n) => {
          if (n.params === 2) throw new Error("못 합친다");
          return { n: [...v.n, n.params] };
        },
      }),
    );
    for (const p of [1, 2, 3]) last().receive({ method: "add", params: p });
    d.resolve({ n: [] });
    await flush();
    expect(rpc.view()).toEqual({ data: { n: [1, 3] }, status: "ready", isFetching: false, error: null });
  });

  it("구독자가 던져도 나머지 구독자를 부른다", async () => {
    const d = deferred<V>();
    const rpc = keep(base({ onConnect: () => d.promise }));
    const after = vi.fn();
    rpc.subscribe(() => {
      throw new Error("구독자");
    });
    rpc.subscribe(after);
    d.resolve({ n: [] });
    await flush();
    expect(after).toHaveBeenCalledTimes(1);
    expect(rpc.view().status).toBe("ready");
  });

  it("준비 때 남은 시간이 0 이하인 요청은 보내지 않고 응답 지연이다", async () => {
    // onConnect 의 타이머를 먼저 걸어, 같은 때 요청의 타이머보다 먼저 준비된다
    const rpc = keep(base({ onConnect: () => new Promise<V>((r) => setTimeout(() => r({ n: [] }), 100)) }));
    const slow = rpc.slow(1).catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(rpc.view().status).toBe("ready");
    expect(await slow).toMatchObject({ message: TEXT.timeout });
    expect(methods()).toEqual([]);
  });

  it("통로가 onClose 를 동기로 부르면 onConnect 를 돌리지 않고 다시 잇는다", async () => {
    const onConnect = vi.fn(() => ({ n: [] }));
    let n = 0;
    const rpc = keep(
      base({
        onConnect,
        connect: () => {
          if (++n > 1) return fake().t;
          const t: Transport = { send() {}, onMessage() {}, onClose: (fn) => fn(), close: vi.fn() };
          return t;
        },
      }),
    );
    expect(onConnect).not.toHaveBeenCalled();
    expect(rpc.view()).toMatchObject({ status: "loading", error: TEXT.reconnecting });
    await vi.advanceTimersByTimeAsync(GAP);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("한 번도 준비되지 않았으면 connect 실패 뒤 다음 onConnect 동안 loading · 재시도 중이다", async () => {
    let n = 0;
    const d = deferred<V>();
    const rpc = keep(
      base({
        onConnect: () => d.promise,
        connect: () => {
          if (++n === 1) throw new Error("없다");
          return fake().t;
        },
      }),
    );
    expect(rpc.view().error).toBe("없다");
    await vi.advanceTimersByTimeAsync(GAP);
    expect(n).toBe(2);
    expect(rpc.view()).toEqual({ data: undefined, status: "loading", isFetching: true, error: TEXT.reconnecting });
    d.resolve({ n: [] });
    await flush();
    expect(rpc.view()).toEqual({ data: { n: [] }, status: "ready", isFetching: false, error: null });
  });
});

describe("close", () => {
  it("다시 잇기를 기다리는 중이면 connect 를 다시 부르지 않는다", async () => {
    const rpc = base({ onConnect: () => ({ n: [5] }) });
    await flush();
    last().end();
    rpc.close();
    await vi.advanceTimersByTimeAsync(GAP * 10);
    expect(fakes).toHaveLength(1);
    expect(rpc.view()).toEqual({ data: { n: [5] }, status: "ready", isFetching: false, error: null });
  });

  it("onConnect 도중이면 통로를 닫고, 기다리던 요청과 보낸 요청은 명령 실패다", async () => {
    const d = deferred<V>();
    const rpc = base({
      onConnect: async (_l, r) => {
        void r.request("initialize").catch(() => {});
        return d.promise;
      },
    });
    const queued = rpc.echo("a").catch((e) => e);
    rpc.close();
    expect(last().t.close).toHaveBeenCalled();
    expect(await queued).toMatchObject({ message: TEXT.commandFailed });
    d.resolve({ n: [] });
    await vi.advanceTimersByTimeAsync(GAP * 10);
    expect(fakes).toHaveLength(1);
    expect(rpc.view()).toEqual({ data: undefined, status: "ready", isFetching: false, error: null });
    await expect(rpc.echo("b")).rejects.toMatchObject({ message: TEXT.commandFailed });
  });

  it("준비된 뒤 보낸 요청은 명령 실패로 끝난다", async () => {
    const rpc = base();
    const sent = rpc.echo("a").catch((e) => e);
    rpc.close();
    expect(await sent).toMatchObject({ message: TEXT.commandFailed });
    expect(last().t.close).toHaveBeenCalled();
  });

  it("connect 의 Promise 가 풀리기 전에 닫으면 풀린 통로를 곧바로 닫는다", async () => {
    const d = deferred<Transport>();
    const rpc = base({ connect: () => d.promise });
    rpc.close();
    const f = fake();
    d.resolve(f.t);
    await flush();
    expect(f.t.close).toHaveBeenCalled();
    expect(rpc.view().status).toBe("ready");
  });
});

describe("store 로 꺼낸다", () => {
  it("resetStores 는 앞 통로를 닫고 새 통로를 연다. disposeStores 는 닫기만 한다", () => {
    createStore("rpc.test", () => createJsonRpc({ connect }));
    const s = getStore("rpc.test" as never) as unknown as { getState(): { [DISPOSE](): void } };
    s.getState();
    expect(fakes).toHaveLength(1);
    resetStores();
    expect(fakes[0]!.t.close).toHaveBeenCalled();
    expect(fakes).toHaveLength(2);
    disposeStores();
    expect(fakes[1]!.t.close).toHaveBeenCalled();
    expect(fakes).toHaveLength(2);
  });
});

it("타입: 요청 · 알림 함수, 정해진 이름, params 하나", () => {
  type DidChange = { uri: string; version: number };
  // 스펙 §6 정의의 꼴 — 타입 인자 넷. 부르지 않는다(타입만 본다)
  const lsp = () =>
    createJsonRpc<V, Note, Cmd, { didChange: DidChange }>({
      connect,
      requests: { echo: { method: "e" }, slow: { method: "s" } },
      notifications: { didChange: "textDocument/didChange" },
    });
  () => {
    const r = lsp();
    expectTypeOf(r.didChange({ uri: "a", version: 1 })).toEqualTypeOf<boolean>();
    expectTypeOf(r.echo("x")).toEqualTypeOf<Promise<string>>();
    expectTypeOf(r.notify("raw")).toEqualTypeOf<boolean>();
    expectTypeOf(r.view()).toEqualTypeOf<ClientView<V>>();
    // @ts-expect-error 알림의 params 타입이 맞아야 한다
    r.didChange({ uri: 1 });
    // @ts-expect-error 넷째 타입 인자에 없는 이름은 부를 수 없다
    r.didClose({});
    // @ts-expect-error 셋째 타입 인자에 없는 이름은 부를 수 없다
    r.hover("x");
    // @ts-expect-error 요청의 params 타입이 맞아야 한다
    r.echo(1);
  };

  // @ts-expect-error 셋째 타입 인자의 이름마다 requests 칸이 있어야 한다
  () => createJsonRpc<V, never, Cmd>({ connect, requests: { echo: { method: "echo" } } });
  // @ts-expect-error requests 를 아예 빼도 오류
  () => createJsonRpc<V, never, Cmd>({ connect });
  // @ts-expect-error 정해진 이름은 요청 이름으로 쓸 수 없다
  () => createJsonRpc<V, never, { close: (p: number) => void }>({ connect, requests: { close: { method: "x" } } });
  // @ts-expect-error 요청 함수는 인자를 하나만 받는다
  () => createJsonRpc<V, never, { two: (a: number, b: number) => void }>({ connect, requests: { two: { method: "two" } } });
  // @ts-expect-error 넷째 타입 인자의 이름마다 notifications 칸이 있어야 한다
  () => createJsonRpc<V, never, {}, { a: number; b: number }>({ connect, notifications: { a: "a" } });
  // @ts-expect-error notifications 를 아예 빼도 오류
  () => createJsonRpc<V, never, {}, { a: number }>({ connect });
  // @ts-expect-error 정해진 이름은 알림 이름으로 쓸 수 없다
  () => createJsonRpc<V, never, {}, { close: number }>({ connect, notifications: { close: "x" } });
  // @ts-expect-error 넷째 타입 인자가 없으면 notifications 에 이름을 적을 수 없다
  () => createJsonRpc<V, never, {}>({ connect, notifications: { didChange: "x" } });
  // @ts-expect-error 셋째 타입 인자가 없으면 requests 에 이름을 적을 수 없다
  () => createJsonRpc<V>({ connect, requests: { echo: { method: "e" } } });
});
