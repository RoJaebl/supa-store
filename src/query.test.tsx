import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, disposeStores, getStore, overrideStore, resetStores } from "./index.js";
import { createEvent, createResource, type Cache, type MutationFn } from "./query.js";
import { useStore } from "./react.js";

beforeEach(() => resetStores());
afterEach(() => void vi.useRealTimers());

// 시험마다 새 key 를 쓴다. 꺼내는 쪽 타입은 아래 타입 시험이 따로 본다
let n = 0;
function define(creator: () => object): string {
  const key = `api.test.r${++n}`;
  createStore(key, creator);
  return key;
}
const view = (key: string, options?: object): any => (useStore as any)(key, options);
const state = (key: string): any => getStore(key as never).getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
/** 부를 때마다 새 약속을 내주고, 시험이 차례대로 풀게 한다 */
function controlled<T>() {
  const calls: Array<{ args: unknown; d: ReturnType<typeof deferred<T>> }> = [];
  const fn = vi.fn((args?: unknown) => {
    const d = deferred<T>();
    calls.push({ args, d });
    return d.promise;
  });
  return { fn, calls };
}
const flush = () => act(async () => {});

// ── 타입 ──────────────────────────────────────────────

it("타입: cache 를 쓰면 (cache: Cache<A, D>) 로 적고, 상태와 화면의 타입이 거기서 나온다", () => {
  const resource = createResource((cache: Cache<void, number[]>) => ({
    query: async () => [1, 2],
    async add(value: number) {
      cache.setData((prev) => [...(prev ?? []), value]);
      return value;
    },
  }));
  expectTypeOf(resource.getData()).toEqualTypeOf<number[] | undefined>();
  expectTypeOf(resource.add).toEqualTypeOf<MutationFn<(value: number) => Promise<number>>>();
  expectTypeOf(resource).not.toHaveProperty("query");
  // cache 를 쓰지 않으면 적지 않아도 query 에서 추론한다
  const plain = createResource(() => ({ query: async (id: string) => id.length }));
  expectTypeOf(plain.fetch("a")).toEqualTypeOf<Promise<number>>();
  expectTypeOf(plain.getData()).toEqualTypeOf<number | undefined>();
});

const typedResource = () =>
  createResource((cache: Cache<void, number[]>) => ({
    query: async () => [1],
    async add(value: number) {
      cache.setData((prev) => [...(prev ?? []), value]);
      return value;
    },
  }));
declare module "./index.js" {
  interface StateTypes {
    "api.types.typed": ReturnType<typeof typedResource>;
  }
}
it("타입: useStore 로 꺼낸 바꾸기의 data 는 any 가 아니다", () => {
  // 부르지 않는다 — 훅 바깥이라 타입만 본다
  const read = () => useStore("api.types.typed");
  type View = ReturnType<typeof read>;
  expectTypeOf<View["add"]["data"]>().not.toBeAny();
  expectTypeOf<View["add"]["data"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<View["data"]>().toEqualTypeOf<number[] | undefined>();
  expectTypeOf<View["add"]["mutateAsync"]>().returns.resolves.toEqualTypeOf<number>();
  expectTypeOf<View["add"]["mutate"]>().returns.toEqualTypeOf<void>();
});

// ── event ─────────────────────────────────────────────

it("event: emit 은 on 한 반응을 부른다", () => {
  const event = createEvent<{ kind: string }>();
  const seen: string[] = [];
  event.on("api.a", (p) => seen.push(`a:${p.kind}`));
  event.on("api.b", (p) => seen.push(`b:${p.kind}`));
  event.emit({ kind: "saved" });
  expect(seen).toEqual(["a:saved", "b:saved"]);
});
it("event: 같은 who 가 다시 on 하면 갈아 끼운다", () => {
  const event = createEvent<number>();
  const first = vi.fn();
  const second = vi.fn();
  event.on("api.a", first);
  event.on("api.a", second);
  event.emit(1);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});
it("event: 풀기 함수는 그 반응을 뗀다", () => {
  const event = createEvent<number>();
  const fn = vi.fn();
  event.on("api.a", fn)();
  event.emit(1);
  expect(fn).not.toHaveBeenCalled();
});
it("event: 같은 who 가 on 과 exempt 를 함께 적으면 던진다 (두 순서 모두)", () => {
  const a = createEvent<number>();
  a.on("api.a", () => {});
  expect(() => a.exempt("api.a", "까닭")).toThrow(/api\.a/);
  const b = createEvent<number>();
  b.exempt("api.a", "까닭");
  expect(() => b.on("api.a", () => {})).toThrow(/api\.a/);
});
it("event: record() 는 on·exempt 를 정렬해 준다", () => {
  const event = createEvent<number>();
  event.on("api.z", () => {});
  event.on("api.b", () => {});
  event.exempt("api.y", "둘째");
  event.exempt("api.c", "첫째");
  expect(event.record()).toEqual({
    on: ["api.b", "api.z"],
    exempt: [
      { who: "api.c", why: "첫째" },
      { who: "api.y", why: "둘째" },
    ],
  });
});

// ── 조회 ──────────────────────────────────────────────

it("조회: 같은 칸을 보는 두 화면이 요청 하나를 나눠 쓴다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const one = renderHook(() => view(key));
  const two = renderHook(() => view(key));
  expect(q.fn).toHaveBeenCalledTimes(1);
  // 받은 값이 없는 처음 받기만 loading 이다
  expect(one.result.current).toMatchObject({ status: "loading", isFetching: true });
  await act(async () => q.calls[0]!.d.resolve(7));
  expect(one.result.current).toMatchObject({ data: 7, status: "ready", error: null, isFetching: false });
  expect(two.result.current.data).toBe(7);
});
it("조회: 자원을 다시 지으면(overrideStore·재등록) 화면이 새 자원으로 다시 받는다", async () => {
  const key = define(() => createResource(() => ({ query: async () => "old" })));
  const { result } = renderHook(() => view(key));
  await flush();
  expect(result.current).toMatchObject({ data: "old", status: "ready" });
  await act(async () => overrideStore(key as never, () => createResource(() => ({ query: async () => "new" }))));
  await flush();
  expect(result.current).toMatchObject({ data: "new", status: "ready" });
});
it("조회: 다시 받는 동안 앞선 data 와 ready 를 남기고 isFetching 만 켠다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const { result } = renderHook(() => view(key));
  await act(async () => q.calls[0]!.d.resolve(1));
  act(() => void result.current.refetch());
  expect(result.current).toMatchObject({ data: 1, status: "ready", isFetching: true });
  await act(async () => q.calls[1]!.d.resolve(2));
  expect(result.current).toMatchObject({ data: 2, status: "ready", isFetching: false });
});
it("조회: 실패한 뒤 다시 받는 동안 error 와 앞선 data 를 남기고, 성공하면 ready", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const { result } = renderHook(() => view(key));
  await act(async () => q.calls[0]!.d.resolve(1));
  await act(async () => {
    const done = result.current.refetch();
    q.calls[1]!.d.reject(new Error("닿지 않는다"));
    await done;
  });
  act(() => void result.current.refetch());
  expect(result.current).toMatchObject({ data: 1, status: "error", error: "닿지 않는다", isFetching: true });
  await act(async () => q.calls[2]!.d.resolve(2));
  expect(result.current).toMatchObject({ data: 2, status: "ready", error: null, isFetching: false });
});
it("조회: invalidate 로 다시 받는 동안에도 status 는 ready 다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const { result } = renderHook(() => view(key));
  await act(async () => q.calls[0]!.d.resolve(1));
  act(() => void state(key).invalidate());
  expect(result.current).toMatchObject({ data: 1, status: "ready", isFetching: true });
  await act(async () => q.calls[1]!.d.resolve(2));
  expect(result.current).toMatchObject({ data: 2, status: "ready", isFetching: false });
});
it("조회: 실패해도 앞선 data 를 남기고 error 를 둔다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const { result } = renderHook(() => view(key));
  await act(async () => q.calls[0]!.d.resolve(1));
  await act(async () => {
    const done = result.current.refetch();
    q.calls[1]!.d.reject(new Error("닿지 않는다"));
    await done;
  });
  expect(result.current).toMatchObject({ data: 1, status: "error", error: "닿지 않는다" });
});
it("조회: A→B→A 에서 늦게 온 A 의 첫 응답은 버린다", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (id: string) => q.fn(id) })));
  const { result, rerender } = renderHook(({ id }) => view(key, { args: id }), { initialProps: { id: "A" } });
  rerender({ id: "B" });
  rerender({ id: "A" });
  expect(q.calls.map((c) => c.args)).toEqual(["A", "B", "A"]);
  await act(async () => q.calls[2]!.d.resolve("A 둘째"));
  await act(async () => q.calls[0]!.d.resolve("A 첫째"));
  expect(result.current.data).toBe("A 둘째");
});
it("조회: auto: false 면 화면이 떠도 받지 않고 refetch 로 받는다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() }), { auto: false }));
  const { result } = renderHook(() => view(key));
  expect(q.fn).not.toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
  await act(async () => {
    const done = result.current.refetch();
    q.calls[0]!.d.resolve(3);
    await done;
  });
  expect(result.current).toMatchObject({ data: 3, status: "ready" });
});
it("조회: query 가 인자를 받는데 args 가 undefined 면 받지 않는다", () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: (id: string) => q.fn(id) })));
  const { result } = renderHook(() => view(key, { args: undefined }));
  expect(q.fn).not.toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
});
it("조회: invalidate() 는 화면이 보는 칸을 모두 다시 받는다", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (id: string) => q.fn(id) })));
  renderHook(() => view(key, { args: "A" }));
  renderHook(() => view(key, { args: "B" }));
  await act(async () => q.calls.forEach((c) => c.d.resolve(`${c.args}1`)));
  await act(async () => {
    const done = state(key).invalidate();
    q.calls.slice(2).forEach((c) => c.d.resolve(`${c.args}2`));
    await done;
  });
  expect(q.calls.map((c) => c.args)).toEqual(["A", "B", "A", "B"]);
  expect(state(key).getData("A")).toBe("A2");
  expect(state(key).getData("B")).toBe("B2");
});
it("무효화: 보지 않는 칸은 곧바로 받지 않고, await 는 보는 칸만 기다리며, 다시 볼 때 앞 값을 보이며 받는다", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (tab: string) => q.fn(tab) })));
  const { result, rerender } = renderHook(({ tab }) => view(key, { args: tab }), { initialProps: { tab: "a" } });
  await act(async () => q.calls[0]!.d.resolve("a1"));
  rerender({ tab: "b" });
  await act(async () => q.calls[1]!.d.resolve("b1"));
  rerender({ tab: "c" });
  await act(async () => q.calls[2]!.d.resolve("c1"));
  let settled = false;
  let done!: Promise<void>;
  act(() => void (done = state(key).invalidate().then(() => void (settled = true))));
  expect(q.calls.map((c) => c.args)).toEqual(["a", "b", "c", "c"]);
  await flush();
  expect(settled).toBe(false);
  await act(async () => q.calls[3]!.d.resolve("c2"));
  await done;
  expect(settled).toBe(true);
  // 낡은 칸 — getData 는 쥔 값을 준다
  expect(state(key).getData("b")).toBe("b1");
  rerender({ tab: "b" });
  expect(q.calls.map((c) => c.args)).toEqual(["a", "b", "c", "c", "b"]);
  expect(result.current).toMatchObject({ data: "b1", status: "ready", isFetching: true });
  await act(async () => q.calls[4]!.d.resolve("b2"));
  expect(result.current).toMatchObject({ data: "b2", isFetching: false });
});
it("무효화: 낡은 칸의 fetch 는 다시 받고 getData 는 쥔 값을 준다", async () => {
  const query = vi.fn(async (id: string) => `${id}${query.mock.calls.length}`);
  const r = createResource(() => ({ query }));
  expect(await r.fetch("a")).toBe("a1");
  await r.invalidate();
  expect(query).toHaveBeenCalledTimes(1);
  expect(r.getData("a")).toBe("a1");
  expect(await r.fetch("a")).toBe("a2");
  // 다시 받았으니 더는 낡지 않다
  expect(await r.fetch("a")).toBe("a2");
  expect(query).toHaveBeenCalledTimes(2);
});
it("무효화: 조건으로 고른 칸만 — 보는 것은 곧바로, 보지 않는 것은 낡음, 고르지 않은 칸은 그대로", async () => {
  type Args = { repo: string; path: string };
  const query = vi.fn(async (a: Args) => `${a.repo}${a.path}`);
  const key = define(() => createResource(() => ({ query })));
  const r = state(key);
  const a1 = { repo: "A", path: "1" };
  const a2 = { repo: "A", path: "2" };
  const b1 = { repo: "B", path: "1" };
  renderHook(() => view(key, { args: a1 }));
  await flush();
  await r.fetch(a2);
  await r.fetch(b1);
  // idle 칸에는 조건을 부르지 않는다
  r.setData(undefined, { repo: "A", path: "3" });
  query.mockClear();
  const pick = vi.fn((a: Args) => a.repo === "A");
  await act(() => r.invalidate(pick));
  expect(query.mock.calls.map(([a]) => a)).toEqual([a1]);
  expect(pick).toHaveBeenCalledTimes(3);
  await r.fetch(a2);
  await r.fetch(b1);
  expect(query.mock.calls.map(([a]) => a)).toEqual([a1, a2]);
});
it("무효화: 낡은 칸을 다시 보는 화면은 첫 판부터 isFetching 이고 앞 값 · ready 를 보인다", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) })));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  first.unmount();
  await act(() => state(key).invalidate());
  const seen: unknown[] = [];
  const { result } = renderHook(() => {
    const v = view(key, { args: "a" });
    seen.push({ data: v.data, status: v.status, isFetching: v.isFetching });
    return v;
  });
  expect(seen[0]).toEqual({ data: "a1", status: "ready", isFetching: true });
  // 칸의 값은 건드리지 않는다. 효과가 받기를 시작해도 보이는 칸이 같아 다시 그리지 않는다
  expect(state(key).getData("a")).toBe("a1");
  expect(q.fn).toHaveBeenCalledTimes(2);
  expect(seen).toHaveLength(1);
  await act(async () => q.calls[1]!.d.resolve("a2"));
  expect(result.current).toMatchObject({ data: "a2", status: "ready", isFetching: false });
});
it("무효화: 낡지 않은 칸을 처음 보는 화면은 받는 중으로 보이지 않는다", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) })));
  const got = state(key).fetch("a");
  q.calls[0]!.d.resolve("a1");
  await got;
  const seen: boolean[] = [];
  renderHook(() => {
    const v = view(key, { args: "a" });
    seen.push(v.isFetching);
    return v;
  });
  await flush();
  expect(seen.every((f) => f === false)).toBe(true);
  expect(q.fn).toHaveBeenCalledTimes(1);
});
it("무효화: 목록 꼴도 칸마다 — 낡은 칸만 첫 판부터 isFetching", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: { id: number }) => q.fn(a) })));
  const r = state(key);
  const loads = [r.fetch({ id: 1 }), r.fetch({ id: 2 })];
  q.calls.forEach((c) => c.d.resolve(`v${(c.args as { id: number }).id}`));
  await Promise.all(loads);
  await r.invalidate({ id: 1 });
  const seen: boolean[][] = [];
  const { result } = renderHook(() => {
    const v = view(key, { args: [{ id: 1 }, { id: 2 }] });
    seen.push(v.map((x: { isFetching: boolean }) => x.isFetching));
    return v;
  });
  expect(seen[0]).toEqual([true, false]);
  expect(q.calls.slice(2).map((c) => c.args)).toEqual([{ id: 1 }]);
  await act(async () => q.calls[2]!.d.resolve("v1 새"));
  expect(result.current.map((x: { data: string; isFetching: boolean }) => [x.data, x.isFetching])).toEqual([
    ["v1 새", false],
    ["v2", false],
  ]);
});
it("무효화: 목록 꼴로 보는 칸은 칸마다 보는 것이라 모두 곧바로 다시 받는다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: (a: { id: number }) => q.fn(a) })));
  renderHook(() => view(key, { args: [{ id: 1 }, { id: 2 }] }));
  await act(async () => q.calls.forEach((c) => c.d.resolve(1)));
  act(() => void state(key).invalidate());
  expect(q.calls.slice(2).map((c) => c.args)).toEqual([{ id: 1 }, { id: 2 }]);
});
it("무효화: 보지 않는 칸이라도 받는 중이면 곧바로 다시 받고, 다시 보는 화면은 그 요청을 나눠 쓴다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const first = renderHook(() => view(key));
  await act(async () => q.calls[0]!.d.resolve(1));
  act(() => void first.result.current.refetch());
  first.unmount();
  // 무효화 앞에 떠난 요청은 버리고 새로 받는다
  act(() => void state(key).invalidate());
  expect(q.fn).toHaveBeenCalledTimes(3);
  const { result } = renderHook(() => view(key));
  expect(q.fn).toHaveBeenCalledTimes(3);
  expect(result.current.isFetching).toBe(true);
  await act(async () => q.calls[1]!.d.resolve(-1));
  expect(result.current).toMatchObject({ data: 1, isFetching: true });
  await act(async () => q.calls[2]!.d.resolve(2));
  expect(result.current).toMatchObject({ data: 2, isFetching: false });
});
it("무효화: 화면 없이 fetch() 를 띄운 채 invalidate() 하면 그 뒤 값은 새 값이다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  // fortuna 의 picks 꼴 — 처음 받는 중에 값이 없으면 무효화하고 기다린다
  const pending = state(key).fetch();
  const done = state(key).invalidate();
  expect(q.fn).toHaveBeenCalledTimes(2);
  q.calls[0]!.d.resolve(1);
  q.calls[1]!.d.resolve(2);
  await done;
  expect(state(key).getData()).toBe(2);
  expect(await pending).toBe(2);
});
it("조회: fetch(args) 는 이미 받은 칸이면 다시 받지 않고 값을 준다", async () => {
  const query = vi.fn(async (id: string) => id.toLowerCase());
  const key = define(() => createResource(() => ({ query })));
  expect(await state(key).fetch("A")).toBe("a");
  expect(await state(key).fetch("A")).toBe("a");
  expect(query).toHaveBeenCalledTimes(1);
});

it("조회: 다시 받는 중에 fetch 하면 앞 값이 아니라 새 값을 기다려 준다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() }), { auto: false }));
  // 보는 칸이라 invalidate 가 곧바로 다시 받는다
  renderHook(() => view(key));
  const first = state(key).fetch();
  q.calls[0]!.d.resolve(1);
  expect(await first).toBe(1);
  void state(key).invalidate();
  const during = state(key).fetch();
  q.calls[1]!.d.resolve(2);
  expect(await during).toBe(2);
  expect(q.fn).toHaveBeenCalledTimes(2);
});
it("조회: 기다리던 요청을 다른 요청이 밀어내면 fetch 는 마지막 요청의 값을 준다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() }), { auto: false }));
  // 보는 칸이라 invalidate 가 곧바로 다시 받는다
  renderHook(() => view(key));
  const first = state(key).fetch();
  q.calls[0]!.d.resolve(1);
  await first;
  void state(key).invalidate();
  const during = state(key).fetch();
  void state(key).invalidate();
  q.calls[1]!.d.resolve(2);
  await flush();
  q.calls[2]!.d.resolve(3);
  expect(await during).toBe(3);
});
it("조회: 받는 중에 setData(undefined) 로 비워도 fetch 는 받은 응답을 준다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() }), { auto: false }));
  void state(key).fetch();
  // 진행 중인 요청을 기다리는 fetch
  const pending = state(key).fetch();
  state(key).setData(undefined);
  q.calls[0]!.d.resolve(5);
  expect(await pending).toBe(5);
  expect(state(key).getData()).toBeUndefined();
});
it("조회: setData 앞에 떠난 조회 응답이 늦게 와도 setData 의 값을 덮지 않는다", async () => {
  const q = controlled<number[]>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const pending = state(key).fetch().catch(() => {});
  state(key).setData([1, 2]);
  q.calls[0]!.d.resolve([1]);
  await pending;
  expect(state(key).getData()).toEqual([1, 2]);
});
it("조회: 받는 중에 setData 로 값을 비우면 칸이 idle 로 돌아가고 다음 fetch 가 새로 받는다", async () => {
  const q = controlled<number[]>();
  const key = define(() => createResource(() => ({ query: () => q.fn() }), { auto: false }));
  const { result } = renderHook(() => view(key));
  const pending = state(key).fetch().catch(() => {});
  act(() => state(key).setData(() => undefined));
  await act(async () => {
    q.calls[0]!.d.resolve([1]);
    await pending;
  });
  expect(result.current).toMatchObject({ data: undefined, status: "idle", error: null });
  act(() => void state(key).fetch().catch(() => {}));
  expect(q.fn).toHaveBeenCalledTimes(2);
  expect(result.current).toMatchObject({ status: "loading", isFetching: true });
});
it("조회: idle 칸에 setData 하면 ready 가 된다", () => {
  const key = define(() => createResource(() => ({ query: async () => 1 }), { auto: false }));
  const { result } = renderHook(() => view(key));
  act(() => state(key).setData(5));
  expect(result.current).toMatchObject({ data: 5, status: "ready", error: null });
});
it("조회: 값 꼴 setData(undefined) 는 updater 꼴처럼 칸을 비워 idle 로 되돌린다", () => {
  const key = define(() => createResource(() => ({ query: async (id: string) => id }), { auto: false }));
  const { result } = renderHook(() => view(key, { args: "A" }));
  act(() => state(key).setData("a", "A"));
  expect(result.current).toMatchObject({ data: "a", status: "ready" });
  act(() => state(key).setData(undefined, "A"));
  expect(result.current).toMatchObject({ data: undefined, status: "idle", error: null });
});
it("타입: 값 꼴 setData 도 undefined 를 받는다 — 낙관적 갱신을 setData(prev) 로 되돌린다", () => {
  createResource((cache: Cache<void, number[]>) => ({
    query: async () => [1],
    async add(value: number) {
      const prev = cache.getData();
      cache.setData((list) => [...(list ?? []), value]);
      cache.setData(prev);
      cache.setData(undefined);
    },
  }));
  // @ts-expect-error 값의 모양은 그대로 본다
  createResource((cache: Cache<void, number[]>) => ({ query: async () => [1], go: async () => cache.setData("x") }));
});

// ── 바꾸기 ────────────────────────────────────────────

it("바꾸기: mutate 는 아무것도 돌려주지 않고, 실패는 error 칸에만 둔다", async () => {
  const key = define(() =>
    createResource(() => ({
      save: async (_x: number) => {
        throw new Error("실패");
      },
    })),
  );
  const { result } = renderHook(() => view(key));
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  const proc = (globalThis as any).process; // 시험 환경에는 node 타입이 없다
  proc.on("unhandledRejection", onUnhandled);
  try {
    let out: unknown = "unset";
    await act(async () => {
      out = result.current.save.mutate(1);
    });
    await new Promise((r) => setTimeout(r, 0)); // 처리되지 않은 거절은 한 틱 뒤에 보고된다
    expect(out).toBeUndefined();
    expect(result.current.save).toMatchObject({ pending: false, error: "실패" });
    expect(unhandled).toEqual([]);
  } finally {
    proc.off("unhandledRejection", onUnhandled);
  }
});
it("바꾸기: mutateAsync 는 결과를 돌려주고 data 칸에도 둔다", async () => {
  const m = controlled<number>();
  const key = define(() => createResource(() => ({ save: (x: number) => m.fn(x) })));
  const { result } = renderHook(() => view(key));
  let p!: Promise<number>;
  act(() => {
    p = result.current.save.mutateAsync(2);
  });
  expect(result.current.save.pending).toBe(true);
  await act(async () => m.calls[0]!.d.resolve(20));
  expect(await p).toBe(20);
  expect(result.current.save).toMatchObject({ pending: false, data: 20, error: null });
});
it("바꾸기: mutateAsync 는 실패하면 원래 오류 객체를 던지고 error 칸에 문구를 둔다", async () => {
  const e = new Error("x");
  const key = define(() =>
    createResource(() => ({
      save: async () => {
        throw e;
      },
    })),
  );
  const { result } = renderHook(() => view(key));
  let p!: Promise<unknown>;
  act(() => {
    p = result.current.save.mutateAsync();
  });
  await expect(p).rejects.toBe(e);
  await flush();
  expect(result.current.save).toMatchObject({ pending: false, error: "x" });
});
it("바꾸기: 뒤 요청에 밀린 mutateAsync 도 자기 결과를 돌려주지만 칸은 덮지 않는다", async () => {
  const m = controlled<string>();
  const key = define(() => createResource(() => ({ go: (x: string) => m.fn(x) })));
  const { result } = renderHook(() => view(key));
  let first!: Promise<string>;
  act(() => {
    first = result.current.go.mutateAsync("첫째");
  });
  act(() => void result.current.go.mutateAsync("둘째"));
  await act(async () => m.calls[1]!.d.resolve("둘째"));
  await act(async () => m.calls[0]!.d.resolve("첫째"));
  expect(await first).toBe("첫째");
  expect(result.current.go).toMatchObject({ pending: false, data: "둘째" });
});
it("바꾸기: 화면 안에서 늦게 온 응답은 버린다", async () => {
  const m = controlled<string>();
  const key = define(() => createResource(() => ({ go: (x: string) => m.fn(x) })));
  const { result } = renderHook(() => view(key));
  act(() => void result.current.go.mutate("첫째"));
  act(() => void result.current.go.mutate("둘째"));
  await act(async () => m.calls[1]!.d.resolve("둘째"));
  await act(async () => m.calls[0]!.d.resolve("첫째"));
  expect(result.current.go).toMatchObject({ pending: false, data: "둘째" });
});
it("바꾸기: 두 화면이 같은 바꾸기 상태를 본다", async () => {
  const m = controlled<number>();
  const key = define(() => createResource(() => ({ save: (x: number) => m.fn(x) })));
  const one = renderHook(() => view(key));
  const two = renderHook(() => view(key));
  act(() => void one.result.current.save.mutate(1));
  expect(two.result.current.save.pending).toBe(true);
  expect(two.result.current.save.inflight).toEqual([[1]]);
  await act(async () => m.calls[0]!.d.resolve(10));
  expect(two.result.current.save).toMatchObject({ pending: false, data: 10, inflight: [] });
});
it("바꾸기: 한 화면의 reset 을 다른 화면도 받는다", async () => {
  const key = define(() => createResource(() => ({ save: async (x: number) => x })));
  const one = renderHook(() => view(key));
  const two = renderHook(() => view(key));
  await act(async () => void one.result.current.save.mutate(3));
  expect(two.result.current.save.data).toBe(3);
  act(() => one.result.current.save.reset());
  expect(two.result.current.save).toMatchObject({ data: undefined, error: null });
});
it("바꾸기: 날아가는 중에 떨어졌다 다시 붙은 화면이 pending 을 본다", async () => {
  const m = controlled<number>();
  const key = define(() => createResource(() => ({ save: (x: number) => m.fn(x) })));
  const one = renderHook(() => view(key));
  act(() => void one.result.current.save.mutate(1));
  one.unmount();
  const two = renderHook(() => view(key));
  expect(two.result.current.save.pending).toBe(true);
  await act(async () => m.calls[0]!.d.resolve(1));
  expect(two.result.current.save.pending).toBe(false);
});
it("바꾸기: store 끼리 부르는 바꾸기는 실패하면 던진다", async () => {
  const key = define(() =>
    createResource(() => ({
      save: async () => {
        throw new Error("저장하지 못했다");
      },
    })),
  );
  await expect(state(key).save()).rejects.toThrow("저장하지 못했다");
});
it("바꾸기: store 에서 바로 부른 바꾸기도 inflight 에 보인다", async () => {
  const m = controlled<number>();
  const key = define(() => createResource(() => ({ save: (x: number) => m.fn(x) })));
  const p = state(key).save(1);
  expect(state(key).save.inflight).toEqual([[1]]);
  expect(state(key).save.pending).toBe(true);
  m.calls[0]!.d.resolve(1);
  await p;
  expect(state(key).save.inflight).toEqual([]);
  expect(state(key).save.data).toBe(1);
});
it("바꾸기: onSuccess 에서 자기 캐시에 setData 하면 앞서 떠난 받기의 응답이 덮지 못한다", async () => {
  const q = controlled<number>();
  const m = controlled<number>();
  const key = define(() => {
    const r = createResource(() => ({ query: () => q.fn(), save: (x: number) => m.fn(x) }), {
      onSuccess: { save: (next) => r.setData(next) },
    });
    return r;
  });
  const fetching = state(key).fetch();
  const saving = state(key).save(2);
  m.calls[0]!.d.resolve(2);
  await saving;
  q.calls[0]!.d.resolve(1);
  await fetching;
  expect(state(key).getData()).toBe(2);
});
it("바꾸기: 날아가는 중에 resetStores 하면 옛 호출은 던지지 않고 새 자원의 inflight 는 비어 있다", async () => {
  const m = controlled<number>();
  const key = define(() => createResource(() => ({ save: (x: number) => m.fn(x) })));
  const p = state(key).save(1);
  resetStores();
  expect(state(key).save.inflight).toEqual([]);
  m.calls[0]!.d.resolve(1);
  await expect(p).resolves.toBe(1);
  expect(state(key).save.inflight).toEqual([]);
});
it("타입: 바꾸기의 inflight 는 인자 목록이고, 콜백은 바꾸기 이름을 열쇠로 결과 타입을 받는다", () => {
  const r = createResource(() => ({ save: async (value: number) => String(value) }), {
    onSuccess: { save: (result) => expectTypeOf(result).toEqualTypeOf<string>() },
    onError: { save: (_e, value) => expectTypeOf(value).toEqualTypeOf<number>() },
    scope: { save: { id: "s" } },
  });
  expectTypeOf(r.save.inflight).toEqualTypeOf<readonly [value: number][]>();
  expectTypeOf(r.save.data).toEqualTypeOf<string | undefined>();
  expectTypeOf(r.save(1)).toEqualTypeOf<Promise<string>>();
  createResource(() => ({ save: async (value: number) => String(value) }), {
    // @ts-expect-error 없는 바꾸기 이름
    onSuccess: { nope: () => {} },
  });
});

// ── 고르기·this·이름 ───────────────────────────────────

it("고르기: pick: [\"save\"] 로 꺼내면 조회를 시작하지 않는다", async () => {
  const query = vi.fn(async () => 1);
  const key = define(() => createResource(() => ({ query, save: async () => 1 })));
  const { result } = renderHook(() => view(key, { pick: ["save"] }));
  await flush();
  expect(query).not.toHaveBeenCalled();
  expect(Object.keys(result.current)).toEqual(["save"]);
});
it("고르기: pick: ['data'] 화면은 다른 화면의 mutate 로 다시 그리지 않는다", async () => {
  const key = define(() => createResource(() => ({ query: async () => 1, save: async (x: number) => x })));
  let renders = 0;
  renderHook(() => (renders++, view(key, { pick: ["data"] })));
  const other = renderHook(() => view(key));
  await flush();
  const before = renders;
  await act(async () => void other.result.current.save.mutate(2));
  expect(renders).toBe(before);
});
it("고르기: 목록 꼴 화면은 다른 화면의 mutate 로 다시 그리지 않는다", async () => {
  const key = define(() => createResource(() => ({ query: async (x: number) => x, save: async (x: number) => x })));
  let renders = 0;
  renderHook(() => (renders++, view(key, { args: [1, 2] })));
  const other = renderHook(() => view(key, { args: 1 }));
  await flush();
  const before = renders;
  await act(async () => void other.result.current.save.mutate(2));
  expect(renders).toBe(before);
});
it("바꾸기: resetStores 는 scope 의 줄을 비운다 — 뒤 호출이 옛 호출을 기다리지 않는다", async () => {
  const m = controlled<number>();
  const key = define(() =>
    createResource(() => ({ save: (x: number) => m.fn(x) }), { scope: { save: { id: "reset-stores" } } }),
  );
  void state(key).save(1);
  resetStores();
  const p = state(key).save(2);
  await Promise.resolve();
  expect(m.calls).toHaveLength(2);
  m.calls[1]!.d.resolve(2);
  await expect(p).resolves.toBe(2);
});
it("this: 메서드 꼴은 this.다른함수() 를 부를 수 있고, 화살표 꼴과 섞어도 된다", async () => {
  const key = define(() =>
    createResource(() => ({
      double: (x: number) => x * 2,
      async quad(x: number) {
        return this.double(this.double(x));
      },
    })),
  );
  expect(await state(key).quad(1)).toBe(4);
  const { result } = renderHook(() => view(key));
  let out: unknown;
  await act(async () => {
    out = await result.current.quad.mutateAsync(2);
  });
  expect(out).toBe(8);
});
it("이름: 바꾸기 이름이 조회 칸(data·status·error·isPlaceholderData·isFetching·refetch)이면 지을 때 던진다", () => {
  for (const name of ["data", "status", "error", "isPlaceholderData", "isFetching", "refetch"]) {
    const key = define(() => createResource(() => ({ [name]: async () => 1 })));
    expect(() => state(key)).toThrow(name);
  }
});

// ── Cache 목록 ─────────────────────────────────────────

it("Cache 목록: getData 는 같은 순서의 배열을 준다", async () => {
  const r = createResource(() => ({ query: async ({ id }: { id: number }) => id * 10 }));
  await r.fetch({ id: 1 });
  expect(r.getData([{ id: 1 }, { id: 2 }])).toEqual([10, undefined]);
  expect(r.getData([])).toEqual([]);
  expectTypeOf(r.getData([{ id: 1 }])).toEqualTypeOf<(number | undefined)[]>();
  expectTypeOf(r.fetch([{ id: 1 }])).toEqualTypeOf<Promise<number[]>>();
});

it("Cache 목록: fetch 는 값 배열을 주고, 하나라도 실패하면 그 오류로 거절한다", async () => {
  const r = createResource(() => ({
    query: async ({ id }: { id: number }) => {
      if (id === 2) throw new Error("둘");
      return id;
    },
  }));
  await expect(r.fetch([{ id: 1 }, { id: 3 }])).resolves.toEqual([1, 3]);
  await expect(r.fetch([{ id: 1 }, { id: 2 }])).rejects.toThrow("둘");
  await expect(r.fetch([])).resolves.toEqual([]);
});

it("Cache 목록: invalidate([a, b]) 는 그 둘만 낡게 하고, invalidate([]) 는 아무것도 하지 않는다", async () => {
  const query = vi.fn(async ({ id }: { id: number }) => id);
  const r = createResource(() => ({ query }));
  await r.fetch([{ id: 1 }, { id: 2 }, { id: 3 }]);
  query.mockClear();
  // 보는 화면이 없으니 곧바로 받지 않고, fetch 할 때 낡은 둘만 다시 받는다
  await r.invalidate([{ id: 1 }, { id: 2 }]);
  expect(query).not.toHaveBeenCalled();
  await r.fetch([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(query.mock.calls.map(([a]) => a.id).sort()).toEqual([1, 2]);
  query.mockClear();
  await r.invalidate([]);
  expect(query).not.toHaveBeenCalled();
});

it("Cache 목록: setData 의 updater 는 args 마다 (prev, args) 로 불린다", () => {
  const r = createResource(() => ({ query: async ({ id }: { id: number }) => id }));
  r.setData((_prev, args) => args.id + 100, [{ id: 1 }, { id: 2 }]);
  expect(r.getData([{ id: 1 }, { id: 2 }])).toEqual([101, 102]);
});

// ── 놓기(release) ─────────────────────────────────────

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

it("release: 0 이면 화면이 내려가면 칸을 놓고, 그때 받는 중이던 응답은 칸을 되살리지 않으며, 다시 보면 loading 부터", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 0 }));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  act(() => void first.result.current.refetch());
  first.unmount();
  tick(0);
  expect(state(key).getData("a")).toBeUndefined();
  await act(async () => q.calls[1]!.d.resolve("늦은 값"));
  expect(state(key).getData("a")).toBeUndefined();
  const { result } = renderHook(() => view(key, { args: "a" }));
  expect(q.fn).toHaveBeenCalledTimes(3);
  expect(result.current).toMatchObject({ data: undefined, status: "loading" });
  await act(async () => q.calls[2]!.d.resolve("a2"));
  expect(result.current).toMatchObject({ data: "a2", status: "ready" });
});
it("release: 1000 이면 그 안에 다시 보면 놓지 않고 앞 값을 보이며, 지나면 놓는다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 1000 }));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  first.unmount();
  tick(999);
  const again = renderHook(() => view(key, { args: "a" }));
  expect(again.result.current).toMatchObject({ data: "a1", status: "ready" });
  tick(5000);
  expect(state(key).getData("a")).toBe("a1");
  again.unmount();
  tick(999);
  expect(state(key).getData("a")).toBe("a1");
  tick(1);
  expect(state(key).getData("a")).toBeUndefined();
  expect(q.fn).toHaveBeenCalledTimes(1);
});
it("release: 두 화면이 같은 args 를 보다가 하나만 내려가면 놓지 않는다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 0 }));
  const one = renderHook(() => view(key, { args: "a" }));
  const two = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  one.unmount();
  tick(1000);
  expect(state(key).getData("a")).toBe("a1");
  two.unmount();
  tick(0);
  expect(state(key).getData("a")).toBeUndefined();
});
it("release: 놓기를 기다리는 칸에 setData · invalidate 가 와도 정한 때에 놓이고 던지지 않는다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 1000 }));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  first.unmount();
  tick(500);
  act(() => state(key).setData("x", "a"));
  await act(() => state(key).invalidate("a"));
  await act(() => state(key).invalidate());
  tick(499);
  expect(state(key).getData("a")).toBe("x");
  tick(1);
  expect(state(key).getData("a")).toBeUndefined();
  await act(() => state(key).invalidate());
  expect(q.fn).toHaveBeenCalledTimes(1);
});
it("release: 화면 없이 fetch 로 받은 칸은 받기가 끝난 뒤 release 가 지나면 놓인다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const r = createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 1000 });
  const got = r.fetch("a");
  vi.advanceTimersByTime(5000);
  q.calls[0]!.d.resolve("a1");
  expect(await got).toBe("a1");
  vi.advanceTimersByTime(999);
  expect(r.getData("a")).toBe("a1");
  vi.advanceTimersByTime(1);
  expect(r.getData("a")).toBeUndefined();
});
it("release: setData 로만 만든 칸도 보는 화면이 없으면 놓인다", () => {
  vi.useFakeTimers();
  const r = createResource(() => ({ query: async (a: string) => a }), { release: 1000 });
  r.setData("x", "a");
  vi.advanceTimersByTime(999);
  expect(r.getData("a")).toBe("x");
  vi.advanceTimersByTime(1);
  expect(r.getData("a")).toBeUndefined();
});
it("release: 받는 중에 놓이면 그 요청을 기다리던 fetch 는 옛 값이 아니라 받은 응답을 준다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 1000 }));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  act(() => void first.result.current.refetch());
  const waiting = state(key).fetch("a");
  first.unmount();
  tick(1000);
  expect(state(key).getData("a")).toBeUndefined();
  q.calls[1]!.d.resolve("a2");
  expect(await waiting).toBe("a2");
});
it("release: 주지 않으면 화면이 내려가도 쥔다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) })));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  first.unmount();
  tick(60_000);
  expect(state(key).getData("a")).toBe("a1");
});
it("release: disposeStores 뒤 앞 자원의 타이머가 터져도 다시 지은 자원의 칸을 지우지 않는다", async () => {
  vi.useFakeTimers();
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) }), { release: 1000 }));
  const first = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[0]!.d.resolve("a1"));
  first.unmount();
  act(() => disposeStores());
  // 다시 지은 자원을 화면이 본다 — 앞 자원의 타이머(1000ms)가 이 칸을 건드리면 안 된다
  tick(500);
  const { result } = renderHook(() => view(key, { args: "a" }));
  await act(async () => q.calls[1]!.d.resolve("새 a"));
  tick(600);
  expect(state(key).getData("a")).toBe("새 a");
  expect(result.current).toMatchObject({ data: "새 a", status: "ready" });
});

it("타입: 동기 바꾸기도 부르면 Promise 를 돌려준다", () => {
  const r = createResource(() => ({ double: (x: number) => x * 2 }));
  expectTypeOf(r.double(1)).toEqualTypeOf<Promise<number>>();
});
