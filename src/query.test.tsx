import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, getStore, overrideStore, resetStores } from "./index.js";
import { createEvent, createResource, type Cache } from "./query.js";
import { useStore } from "./react.js";

beforeEach(() => resetStores());

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
  expectTypeOf(resource.add).toEqualTypeOf<(value: number) => Promise<number>>();
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
it("조회: invalidate() 는 받아 둔 칸을 모두 다시 받는다", async () => {
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
it("조회: fetch(args) 는 이미 받은 칸이면 다시 받지 않고 값을 준다", async () => {
  const query = vi.fn(async (id: string) => id.toLowerCase());
  const key = define(() => createResource(() => ({ query })));
  expect(await state(key).fetch("A")).toBe("a");
  expect(await state(key).fetch("A")).toBe("a");
  expect(query).toHaveBeenCalledTimes(1);
});

it("조회: 다시 받는 중에 fetch 하면 앞 값이 아니라 새 값을 기다려 준다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
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
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
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

it("바꾸기: 진행·오류·결과는 부른 화면의 것이다", async () => {
  const m = controlled<number>();
  const key = define(() => createResource(() => ({ save: (x: number) => m.fn(x) })));
  const one = renderHook(() => view(key));
  const two = renderHook(() => view(key));
  act(() => void one.result.current.save.mutate(1));
  expect(one.result.current.save.pending).toBe(true);
  expect(two.result.current.save.pending).toBe(false);
  await act(async () => m.calls[0]!.d.resolve(10));
  expect(one.result.current.save).toMatchObject({ pending: false, data: 10, error: null });
  expect(two.result.current.save.data).toBeUndefined();
  act(() => one.result.current.save.reset());
  expect(one.result.current.save.data).toBeUndefined();
});
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

// ── 고르기·this·이름 ───────────────────────────────────

it("고르기: pick: [\"save\"] 로 꺼내면 조회를 시작하지 않는다", async () => {
  const query = vi.fn(async () => 1);
  const key = define(() => createResource(() => ({ query, save: async () => 1 })));
  const { result } = renderHook(() => view(key, { pick: ["save"] }));
  await flush();
  expect(query).not.toHaveBeenCalled();
  expect(Object.keys(result.current)).toEqual(["save"]);
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

it("Cache 목록: invalidate([a, b]) 는 그 둘만 다시 받고, invalidate([]) 는 아무것도 하지 않는다", async () => {
  const query = vi.fn(async ({ id }: { id: number }) => id);
  const r = createResource(() => ({ query }));
  await r.fetch([{ id: 1 }, { id: 2 }, { id: 3 }]);
  query.mockClear();
  await r.invalidate([{ id: 1 }, { id: 2 }]);
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
