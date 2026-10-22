import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, getStore, resetStores } from "./index.js";
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
  expectTypeOf(plain.fetch).parameter(0).toEqualTypeOf<string | undefined>();
  expectTypeOf(plain.getData()).toEqualTypeOf<number | undefined>();
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
  expect(one.result.current.status).toBe("loading");
  await act(async () => q.calls[0]!.d.resolve(7));
  expect(one.result.current).toMatchObject({ data: 7, status: "ready", error: null });
  expect(two.result.current.data).toBe(7);
});
it("조회: 다시 받는 동안 앞선 data 를 남긴다", async () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const { result } = renderHook(() => view(key));
  await act(async () => q.calls[0]!.d.resolve(1));
  act(() => void result.current.refetch());
  expect(result.current).toMatchObject({ data: 1, status: "loading" });
  await act(async () => q.calls[1]!.d.resolve(2));
  expect(result.current).toMatchObject({ data: 2, status: "ready" });
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

it("조회: setData 앞에 떠난 조회 응답이 늦게 와도 setData 의 값을 덮지 않는다", async () => {
  const q = controlled<number[]>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  const pending = state(key).fetch().catch(() => {});
  state(key).setData([1, 2]);
  q.calls[0]!.d.resolve([1]);
  await pending;
  expect(state(key).getData()).toEqual([1, 2]);
});
it("조회: idle 칸에 setData 하면 ready 가 된다", () => {
  const key = define(() => createResource(() => ({ query: async () => 1 }), { auto: false }));
  const { result } = renderHook(() => view(key));
  act(() => state(key).setData(5));
  expect(result.current).toMatchObject({ data: 5, status: "ready", error: null });
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
it("바꾸기: mutate 는 실패해도 던지지 않고 error 를 둔다", async () => {
  const key = define(() =>
    createResource(() => ({
      save: async () => {
        throw new Error("저장하지 못했다");
      },
    })),
  );
  const { result } = renderHook(() => view(key));
  let out: unknown = "unset";
  await act(async () => {
    out = await result.current.save.mutate();
  });
  expect(out).toBeUndefined();
  expect(result.current.save).toMatchObject({ pending: false, error: "저장하지 못했다" });
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
    out = await result.current.quad.mutate(2);
  });
  expect(out).toBe(8);
});
it("이름: 바꾸기 이름이 data·status·error·refetch 면 지을 때 던진다", () => {
  for (const name of ["data", "status", "error", "refetch"]) {
    const key = define(() => createResource(() => ({ [name]: async () => 1 })));
    expect(() => state(key)).toThrow(name);
  }
});
