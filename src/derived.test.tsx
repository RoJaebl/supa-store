import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, getStore, overrideStore, resetStores, type Derived } from "./index.js";
import { createDerived, createResource, type Resource } from "./query.js";
import { useStore } from "./react.js";

declare module "./index.js" {
  interface StateTypes {
    "state.d.a": { n: number; inc: () => void };
    "state.d.b": { m: number; setM: (m: number) => void };
    "state.d.sum": Derived<{ total: number }>;
    "state.d.twice": Derived<number>;
    "state.d.positive": Derived<boolean>;
    "state.d.history": Derived<number[]>;
    "api.d.item": Resource<{ id: number }, { id: number; name: string }, object>;
    "state.d.pick": { id: number; setId: (id: number) => void };
    "state.d.label": Derived<string>;
    "state.d.itemOne": Derived<{ id: number; name: string } | undefined>;
  }
}

let runs = 0;
createStore("state.d.a", (set) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));
createStore("state.d.b", (set) => ({ m: 10, setM: (m: number) => set({ m }) }));
createStore("state.d.sum", (_s, _g, ctx) =>
  createDerived(() => (runs++, { total: ctx("state.d.a").n + ctx("state.d.b").m })),
);
createStore("state.d.twice", (_s, _g, ctx) => createDerived(() => ctx("state.d.sum").total * 2));
createStore("state.d.positive", (_s, _g, ctx) => createDerived(() => ctx("state.d.a").n > 0));
createStore("state.d.history", (_s, _g, ctx) =>
  createDerived((prev: number[] | undefined) => [...(prev ?? []), ctx("state.d.a").n]),
);

const derived = <K extends "state.d.sum" | "state.d.twice" | "state.d.positive" | "state.d.history">(key: K) =>
  getStore(key).getState();
const a = () => getStore("state.d.a").getState();

beforeEach(() => {
  resetStores();
  runs = 0;
});

it("입력이 바뀌면 다시 계산해 알린다", () => {
  let calls = 0;
  const stop = derived("state.d.sum").subscribe(() => calls++);
  expect(derived("state.d.sum").get().total).toBe(11);
  a().inc();
  expect(derived("state.d.sum").get().total).toBe(12);
  expect(calls).toBe(1);
  stop();
});

it("결과가 같으면 깨우지 않는다", () => {
  let calls = 0;
  const stop = derived("state.d.positive").subscribe(() => calls++);
  a().inc();
  expect(calls).toBe(0);
  stop();
});

it("입력이 그대로면 다시 계산하지 않는다", () => {
  derived("state.d.sum").get();
  derived("state.d.sum").get();
  expect(runs).toBe(1);
});

it("구독이 끊긴 사이 바뀐 입력을 다시 붙을 때 반영한다", () => {
  const stop = derived("state.d.sum").subscribe(() => {});
  stop();
  a().inc();
  const again = derived("state.d.sum").subscribe(() => {});
  expect(derived("state.d.sum").get().total).toBe(12);
  again();
});

it("파생이 파생을 읽는다", () => {
  const stop = derived("state.d.twice").subscribe(() => {});
  expect(derived("state.d.twice").get()).toBe(22);
  a().inc();
  expect(derived("state.d.twice").get()).toBe(24);
  stop();
});

it("입력 store 를 다시 지으면 새 상태로 계산한다", () => {
  expect(derived("state.d.sum").get().total).toBe(11);
  overrideStore("state.d.a", () => ({ n: 5, inc: () => {} }));
  expect(derived("state.d.sum").get().total).toBe(15);
});

it("useStore 로 꺼내면 값을 준다", () => {
  const { result } = renderHook(() => useStore("state.d.sum"));
  expectTypeOf(result.current).toEqualTypeOf<{ total: number }>();
  expect(result.current.total).toBe(11);
  act(() => a().inc());
  expect(result.current.total).toBe(12);
});

it("React 밖에서 getStore(key).getState().get() 으로 읽는다", () => {
  expect(getStore("state.d.sum").getState().get().total).toBe(11);
});

it("compute 는 앞 결과를 prev 로 받는다", () => {
  expect(derived("state.d.history").get()).toEqual([1]);
  a().inc();
  expect(derived("state.d.history").get()).toEqual([1, 2]);
});

// ── 자원 칸을 계산 공간에서 읽는다 ─────────────────────

let queries = 0;
createStore("api.d.item", () =>
  createResource(() => ({ query: async (a: { id: number }) => (queries++, { id: a.id, name: `n${a.id}` }) }), { release: 100 }),
);
createStore("state.d.pick", (set) => ({ id: 1, setId: (id: number) => set({ id }) }));
createStore("state.d.label", (_s, _g, ctx) =>
  createDerived((prev: string | undefined) => ctx("api.d.item").getData({ id: ctx("state.d.pick").id })?.name ?? prev ?? "-"),
);
createStore("state.d.itemOne", (_s, _g, ctx) => createDerived(() => ctx("api.d.item").getData({ id: 1 })));
const label = () => getStore("state.d.label").getState();
const settle = () => act(async () => {});

it("구독하면 자원을 받고, 받으면 다시 계산한다", async () => {
  queries = 0;
  const stop = label().subscribe(() => {});
  expect(label().get()).toBe("-");
  await settle();
  expect(label().get()).toBe("n1");
  expect(queries).toBe(1);
  stop();
});

it("args 가 바뀌면 앞 칸을 놓고 prev 로 잇는다", async () => {
  vi.useFakeTimers();
  const stop = label().subscribe(() => {});
  await vi.runAllTimersAsync();
  expect(label().get()).toBe("n1");
  getStore("state.d.pick").getState().setId(2);
  expect(label().get()).toBe("n1");
  await vi.advanceTimersByTimeAsync(0);
  expect(label().get()).toBe("n2");
  await vi.advanceTimersByTimeAsync(100);
  expect(getStore("api.d.item").getState().getData({ id: 1 })).toBeUndefined();
  stop();
  vi.useRealTimers();
});

it("구독자가 없으면 자원을 받지 않는다", async () => {
  queries = 0;
  expect(label().get()).toBe("-");
  await settle();
  expect(queries).toBe(0);
});

it("다시 받은 응답이 같으면 깨우지 않는다", async () => {
  let calls = 0;
  const one = getStore("state.d.itemOne").getState();
  const stop = one.subscribe(() => calls++);
  await settle();
  expect(one.get()?.name).toBe("n1");
  calls = 0;
  await act(() => getStore("api.d.item").getState().invalidate({ id: 1 }));
  expect(calls).toBe(0);
  stop();
});
