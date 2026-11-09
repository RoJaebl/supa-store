import { renderHook } from "@testing-library/react";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, disposeStores, getStore, overrideStore, resetStores, type Store } from "./index.js";
import { createDerived, createEvent, createResource } from "./query.js";
import { useStore } from "./react.js";

// 시험마다 새 event store 를 쓴다 — 공용 event 를 쓰면 resetStores 가 앞 시험의 store 를 다시 걸어 얽힌다
const makeEvent = () => createStore(() => createEvent<{ id: string }>());

afterEach(() => {
  disposeStores();
  vi.unstubAllEnvs();
});

it("자원의 타입이 정의에서 추론된다", () => {
  const ev = makeEvent();
  const todos = createStore.ofContext((ctx) => {
    ctx(ev).on(({ id }) => expectTypeOf(id).toEqualTypeOf<string>());
    return createResource(() => ({ query: async (a: { q: string }) => [a.q], add: async (t: string) => t }));
  });
  expectTypeOf(getStore(todos).getState().getData({ q: "x" })).toEqualTypeOf<string[] | undefined>();
});

it("파생이 기댄 store 를 따라 다시 계산한다", () => {
  const count = createStore<{ n: number }>(() => ({ n: 1 }));
  const double = createStore.ofContext((ctx) => createDerived(() => ctx(count).n * 2));
  const seen: number[] = [];
  const off = getStore(double).subscribe(() => seen.push(getStore(double).getState().get()));
  expect(getStore(double).getState().get()).toBe(2);
  getStore(count).setState({ n: 5 });
  expect(getStore(double).getState().get()).toBe(10);
  off();
});

it("ctx() 는 unknown 이다", () => {
  createStore.ofContext((ctx) => {
    const self = ctx();
    expectTypeOf(self).toBeUnknown();
    // @ts-expect-error unknown 이라 칸을 읽지 못한다 — 자기 자신은 자기 핸들로 읽는다
    void (() => self.patch);
    return {};
  });
  const self = createStore.ofContext((ctx) => ({ read: () => ctx() }));
  expectTypeOf(getStore(self).getState().read()).toEqualTypeOf<unknown>();
});

it("useStore 의 pick · omit 이 고른 칸만 낸다", () => {
  const ev = makeEvent();
  const actions = createStore.ofContext((ctx) => ({ save: () => ctx(ev).emit({ id: "1" }), reset: () => 2 }));
  const omitted = renderHook(() => useStore(actions, { omit: ["save"] }));
  expect(Object.keys(omitted.result.current)).toEqual(["reset"]);
  const picked = renderHook(() => useStore(actions, { pick: ["save"] }));
  expect(Object.keys(picked.result.current)).toEqual(["save"]);
  // @ts-expect-error 없는 이름
  renderHook(() => useStore(actions, { pick: ["nope"] }));
});

it("getStore 는 overrideStore · resetStores · disposeStores 뒤에도 같은 객체이고 구독이 남는다", () => {
  const box = createStore.ofContext(() => ({ v: 1 }));
  const api = getStore(box);
  let calls = 0;
  const off = api.subscribe(() => calls++);
  api.getState();
  overrideStore(box, () => ({ v: 2 }));
  expect(getStore(box)).toBe(api);
  expect(api.getState().v).toBe(2);
  resetStores();
  expect(getStore(box)).toBe(api);
  expect(api.getState().v).toBe(1);
  disposeStores();
  expect(getStore(box)).toBe(api);
  api.setState({ v: 3 });
  expect(calls).toBeGreaterThan(0);
  off();
});

it("짓는 동안 건 on 이 overrideStore · resetStores · disposeStores 뒤에 하나만 남는다", () => {
  const ev = makeEvent();
  const seen: string[] = [];
  const r = createStore.ofContext((ctx) => (ctx(ev).on(({ id }) => seen.push(id)), {}));
  getStore(r).getState();
  overrideStore(r, (_s, _g, ctx) => (ctx(ev).on(({ id }) => seen.push(`o${id}`)), {}));
  getStore(ev).getState().emit({ id: "1" });
  expect(seen).toEqual(["o1"]);
  resetStores();
  getStore(r).getState();
  disposeStores();
  getStore(r).getState();
  getStore(ev).getState().emit({ id: "2" });
  expect(seen).toEqual(["o1", "2"]);
});

it("ofContext store 에 ctx 로 기댄 store 는 그것을 overrideStore 하면 다시 지어진다", () => {
  const base = createStore.ofContext(() => ({ v: 1 }));
  const reader = createStore.ofContext((ctx) => ({ v: ctx(base).v * 10 }));
  expect(getStore(reader).getState().v).toBe(10);
  overrideStore(base, () => ({ v: 2 }));
  expect(getStore(reader).getState().v).toBe(20);
});

it("overrideStore 의 creator 는 세 인자 꼴이고 일부 칸만 돌려줘도 된다", () => {
  const actions = createStore.ofContext(() => ({ save: () => 1, reset: () => 2 }));
  overrideStore(actions, () => ({ save: () => 9 }));
  expect(getStore(actions).getState().save()).toBe(9);
});

it("서로를 가리키는 두 store 는 변수에 타입을 적으면 지나간다", () => {
  const a: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore.ofContext(() => ({ n: 1 }));
  expect(getStore(a).getState().n).toBe(1);
});

it("순환 오류의 이름이 이 시험 파일을 가리키고 index 를 가리키지 않는다", () => {
  const a: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(a).n }));
  let message = "";
  try {
    getStore(a).getState();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/순환한다: .*ofContext\.test\.tsx:\d+ → .*ofContext\.test\.tsx:\d+/);
  expect(message).not.toMatch(/index\.(ts|js):/);
});

it("record() 의 who 가 이 시험 파일을 가리킨다", () => {
  const ev = makeEvent();
  const r = createStore.ofContext((ctx) => (ctx(ev).on(() => {}), {}));
  getStore(r).getState();
  expect(getStore(ev).getState().record().on).toEqual([expect.stringMatching(/ofContext\.test\.tsx:\d+$/)]);
});

it("배포 모드에서는 이름이 #<n> 이다", () => {
  vi.stubEnv("NODE_ENV", "production");
  const a: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(a).n }));
  expect(() => getStore(a).getState()).toThrow(/순환한다: #\d+ → #\d+/);
});
