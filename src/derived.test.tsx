import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, getStore, overrideStore, resetStores, type Derived, type Store } from "./index.js";
import { createDerived, createResource, type Resource } from "./query.js";
import { useStore } from "./react.js";

let runs = 0;
const aStore = createStore<{ n: number; inc: () => void }>((set) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));
const bStore = createStore<{ m: number; setM: (m: number) => void }>((set) => ({ m: 10, setM: (m: number) => set({ m }) }));
const sumStore = createStore<Derived<{ total: number }>>((_s, _g, ctx) =>
  createDerived(() => (runs++, { total: ctx(aStore).n + ctx(bStore).m })),
);
const twiceStore = createStore<Derived<number>>((_s, _g, ctx) => createDerived(() => ctx(sumStore).total * 2));
const positiveStore = createStore<Derived<boolean>>((_s, _g, ctx) => createDerived(() => ctx(aStore).n > 0));
const historyStore = createStore<Derived<number[]>>((_s, _g, ctx) =>
  createDerived((prev: number[] | undefined) => [...(prev ?? []), ctx(aStore).n]),
);

const derived = <T,>(store: Store<Derived<T>>) => getStore(store).getState();
const a = () => getStore(aStore).getState();

beforeEach(() => {
  resetStores();
  runs = 0;
});

it("입력이 바뀌면 다시 계산해 알린다", () => {
  let calls = 0;
  const stop = derived(sumStore).subscribe(() => calls++);
  expect(derived(sumStore).get().total).toBe(11);
  a().inc();
  expect(derived(sumStore).get().total).toBe(12);
  expect(calls).toBe(1);
  stop();
});

it("결과가 같으면 깨우지 않는다", () => {
  let calls = 0;
  const stop = derived(positiveStore).subscribe(() => calls++);
  a().inc();
  expect(calls).toBe(0);
  stop();
});

it("입력이 그대로면 다시 계산하지 않는다", () => {
  derived(sumStore).get();
  derived(sumStore).get();
  expect(runs).toBe(1);
});

it("구독이 끊긴 사이 바뀐 입력을 다시 붙을 때 반영한다", () => {
  const stop = derived(sumStore).subscribe(() => {});
  stop();
  a().inc();
  const again = derived(sumStore).subscribe(() => {});
  expect(derived(sumStore).get().total).toBe(12);
  again();
});

it("파생이 파생을 읽는다", () => {
  const stop = derived(twiceStore).subscribe(() => {});
  expect(derived(twiceStore).get()).toBe(22);
  a().inc();
  expect(derived(twiceStore).get()).toBe(24);
  stop();
});

it("입력 store 를 다시 지으면 새 상태로 계산한다", () => {
  expect(derived(sumStore).get().total).toBe(11);
  overrideStore(aStore, () => ({ n: 5, inc: () => {} }));
  expect(derived(sumStore).get().total).toBe(15);
});

it("useStore 로 꺼내면 값을 준다", () => {
  const { result } = renderHook(() => useStore(sumStore));
  expectTypeOf(result.current).toEqualTypeOf<{ total: number }>();
  expect(result.current.total).toBe(11);
  act(() => a().inc());
  expect(result.current.total).toBe(12);
});

it("React 밖에서 getStore(handle).getState().get() 으로 읽는다", () => {
  expect(getStore(sumStore).getState().get().total).toBe(11);
});

it("compute 는 앞 결과를 prev 로 받는다", () => {
  expect(derived(historyStore).get()).toEqual([1]);
  a().inc();
  expect(derived(historyStore).get()).toEqual([1, 2]);
});

// ── 자원 칸을 계산 공간에서 읽는다 ─────────────────────

let queries = 0;
const itemStore = createStore(() =>
  createResource(() => ({ query: async (a: { id: number }) => (queries++, { id: a.id, name: `n${a.id}` }) }), { release: 100 }),
);
const pickStore = createStore<{ id: number; setId: (id: number) => void }>((set) => ({ id: 1, setId: (id: number) => set({ id }) }));
const labelStore = createStore<Derived<string>>((_s, _g, ctx) =>
  createDerived((prev: string | undefined) => ctx(itemStore).getData({ id: ctx(pickStore).id })?.name ?? prev ?? "-"),
);
const itemOneStore = createStore<Derived<{ id: number; name: string } | undefined>>((_s, _g, ctx) => createDerived(() => ctx(itemStore).getData({ id: 1 })));
const label = () => getStore(labelStore).getState();
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
  getStore(pickStore).getState().setId(2);
  expect(label().get()).toBe("n1");
  await vi.advanceTimersByTimeAsync(0);
  expect(label().get()).toBe("n2");
  await vi.advanceTimersByTimeAsync(100);
  expect(getStore(itemStore).getState().getData({ id: 1 })).toBeUndefined();
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
  const one = getStore(itemOneStore).getState();
  const stop = one.subscribe(() => calls++);
  await settle();
  expect(one.get()?.name).toBe("n1");
  calls = 0;
  await act(() => getStore(itemStore).getState().invalidate({ id: 1 }));
  expect(calls).toBe(0);
  stop();
});

// ── 검토가 짚은 결함 ─────────────────────────────────

const cellStore = createStore<Resource<{ id: number }, number, object>>(() => createResource(() => ({ query: async () => 0 }), { auto: false }));
const idsStore = createStore<{ ids: number[]; setIds: (ids: number[]) => void }>((set) => ({ ids: [1, 2], setIds: (ids: number[]) => set({ ids }) }));
const cellsStore = createStore<Derived<string>>((_s, _g, ctx) =>
  createDerived(() => ctx(idsStore).ids.map((id) => ctx(cellStore).getData({ id }) ?? 0).join(",")),
);
const tensStore = createStore<Derived<number>>((_s, _g, ctx) => createDerived(() => ctx(aStore).n * 10));
const pairStore = createStore<Derived<string>>((_s, _g, ctx) => createDerived(() => `${ctx(aStore).n}/${ctx(tensStore)}`));
const flagStore = createStore<{ on: boolean; turnOn: () => void }>((set) => ({ on: false, turnOn: () => set({ on: true }) }));
const selfStore = createStore<Derived<number>>((_s, _g, ctx) => createDerived((): number => (ctx(flagStore).on ? ctx(selfStore) + 1 : 0)));

it("자원 칸 하나를 놓아도 같은 자원의 다른 칸은 계속 따라간다", () => {
  const cells = getStore(cellsStore).getState();
  const stop = cells.subscribe(() => {});
  getStore(idsStore).getState().setIds([2]);
  getStore(cellStore).getState().setData(5, { id: 2 });
  expect(cells.get()).toBe("5");
  stop();
});

it("다이아몬드 의존에서 중간값을 보이지 않는다", () => {
  const pair = getStore(pairStore).getState();
  const seen: string[] = [];
  const stop = pair.subscribe(() => seen.push(pair.get()));
  expect(pair.get()).toBe("1/10");
  a().inc();
  expect(seen).toEqual(["2/20"]);
  stop();
});

it("구독 중에 자기 자신을 읽으면 그 뜻의 오류로 멈춘다", () => {
  const self = getStore(selfStore).getState();
  const stop = self.subscribe(() => {});
  expect(() => getStore(flagStore).getState().turnOn()).toThrow("파생 store 가 계산 중에 자기 자신을 읽었다");
  stop();
});
