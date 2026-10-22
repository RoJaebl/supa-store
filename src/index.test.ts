import { beforeEach, expect, it, vi } from "vitest";
import { createStore, getStore, overrideStore, pickFrom, registeredKeys, resetStores } from "./index.js";

declare module "./index.js" {
  interface StateTypes {
    "state.test.count": { n: number; add: () => void };
    "state.test.pair": { a: number; b: number; setA: (a: number) => void };
    "lazy.built": { n: number };
    "ctx.source": { n: number; m: number };
    "ctx.reader": { read: () => number; picked: () => object; own: string };
    a: { n: number };
    b: { n: number };
    "order.first": { n: number };
    "order.second": { n: number };
    infra: { v: string };
    "infra.reader": { read: () => string };
    ev: { on: (f: () => void) => void; emit: () => void };
    listener: object;
  }
}

createStore("state.test.count", (set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));
createStore("state.test.pair", (set) => ({ a: 1, b: 2, setA: (a: number) => set({ a }) }));

beforeEach(() => resetStores());

it("등록하면 곧 읽힌다", () => {
  expect(getStore("state.test.count").getState().n).toBe(0);
});
it("setState 는 얕게 합치고 나머지 필드를 남긴다", () => {
  getStore("state.test.pair").getState().setA(5);
  expect(getStore("state.test.pair").getState()).toMatchObject({ a: 5, b: 2 });
});
it("함수 꼴 setState 가 지금 값을 받는다", () => {
  getStore("state.test.pair").setState((now) => ({ b: now.b * 10 }));
  expect(getStore("state.test.pair").getState().b).toBe(20);
});
it("같은 객체를 돌려주면 구독자를 부르지 않는다", () => {
  const store = getStore("state.test.pair");
  let calls = 0;
  store.subscribe(() => calls++);
  store.setState((now) => now);
  expect(calls).toBe(0);
});
it("구독을 풀면 더 부르지 않는다", () => {
  const store = getStore("state.test.count");
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.getState().add();
  off();
  store.getState().add();
  expect(calls).toBe(1);
});
it("resetStores 뒤에는 처음 값이고 구독자는 남아 알림을 받는다", () => {
  const store = getStore("state.test.count");
  let calls = 0;
  store.subscribe(() => calls++);
  store.getState().add();
  resetStores();
  expect(store.getState().n).toBe(0);
  expect(store.getInitialState().n).toBe(0);
  expect(calls).toBe(2);
});
it("개발 모드에서 같은 key 를 다시 등록하면 새 정의로 바뀌고 구독자는 남는다", () => {
  const store = getStore("state.test.count");
  let calls = 0;
  store.subscribe(() => calls++);
  createStore("state.test.count", (set, get) => ({ n: 100, add: () => set({ n: get().n + 1 }) }));
  expect(getStore("state.test.count")).toBe(store);
  expect(store.getState().n).toBe(100);
  expect(calls).toBe(1);
  // 원래 정의로 되돌린다
  createStore("state.test.count", (set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));
});
it("production 에서 같은 key 를 두 번 등록하면 실패한다", () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    expect(() => createStore("state.test.count", () => ({ n: 0, add() {} }))).toThrow(
      "같은 key 를 두 번 등록했다: state.test.count",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
it("등록되지 않은 key 는 key 이름을 담아 실패한다", () => {
  expect(() => getStore("state.test.none" as never)).toThrow("등록되지 않은 key 다: state.test.none");
});
it("registeredKeys 는 정렬된 key 목록이다", () => {
  const keys = registeredKeys();
  expect(keys).toEqual([...keys].sort());
  expect(keys).toEqual(expect.arrayContaining(["state.test.count", "state.test.pair"]));
});

// --- 2단계: ctx · 처음 꺼낼 때 짓기 · overrideStore · pick/omit ---

const built = vi.fn();
createStore("lazy.built", () => {
  built();
  return { n: 0 };
});
createStore("ctx.source", () => ({ n: 1, m: 2 }));
createStore("ctx.reader", (_set, _get, ctx) => ({
  read: () => ctx("ctx.source").n,
  picked: () => ctx("ctx.source", { pick: ["n"] }),
  own: ctx.key,
}));
createStore("a", (_set, _get, ctx) => ({ n: ctx("b").n }));
createStore("b", (_set, _get, ctx) => ({ n: ctx("a").n }));
createStore("order.first", (_set, _get, ctx) => ({ n: ctx("order.second").n + 1 }));
createStore("order.second", () => ({ n: 1 }));
createStore("infra", () => ({ v: "real" }));
createStore("infra.reader", (_set, _get, ctx) => ({ read: () => ctx("infra").v }));

const reaction = vi.fn();
function makeEvent() {
  const listeners = new Set<() => void>();
  return { on: (f: () => void) => void listeners.add(f), emit: () => listeners.forEach((f) => f()) };
}
createStore("ev", makeEvent);
createStore("listener", (_set, _get, ctx) => {
  ctx("ev").on(reaction);
  return {};
});

it("등록만 하면 짓지 않는다", () => {
  expect(built).toHaveBeenCalledTimes(0);
  getStore("lazy.built").getState();
  expect(built).toHaveBeenCalledTimes(1);
});
it("ctx(key) 는 부르는 순간의 값을 준다", () => {
  const { read } = getStore("ctx.reader").getState();
  getStore("ctx.source").setState({ n: 2 });
  expect(read()).toBe(2);
});
it("ctx(key, { pick }) 는 고른 칸만 준다", () => {
  expect(Object.keys(getStore("ctx.reader").getState().picked())).toEqual(["n"]);
});
it("ctx.key 는 짓고 있는 store 의 key 다", () => {
  expect(getStore("ctx.reader").getState().own).toBe("ctx.reader");
});
it("짓는 사슬이 돌면 순환으로 실패한다", () => {
  expect(() => getStore("a").getState()).toThrow(/순환한다: a → b → a/);
});
it("등록 순서와 상관없이 짓는 순간 다른 store 를 꺼낸다", () => {
  expect(() => getStore("order.first").getState()).not.toThrow();
  expect(getStore("order.first").getState().n).toBe(2);
});
it("overrideStore 는 처음 정의 대신 짓고, resetStores 가 되돌린다", () => {
  const { read } = getStore("infra.reader").getState();
  overrideStore("infra", () => ({ v: "fake" }));
  expect(read()).toBe("fake");
  resetStores();
  expect(getStore("infra.reader").getState().read()).toBe("real");
});
it("덮어쓰면 그 key 를 짓는 동안 꺼낸 store 도 다시 짓는다", () => {
  getStore("listener").getState();
  reaction.mockClear();
  overrideStore("ev", makeEvent);
  getStore("ev").getState().emit();
  expect(reaction).toHaveBeenCalledTimes(1);
});
it("getStore(key) 는 다시 지어도 같은 객체다", () => {
  const before = getStore("infra");
  overrideStore("infra", () => ({ v: "fake" }));
  expect(getStore("infra")).toBe(before);
});
it("pickFrom 이 고른 메서드는 원래 객체를 this 로 쓴다", () => {
  const s = {
    n: 1,
    read() {
      return this.n;
    },
  };
  expect((pickFrom(s, { pick: ["read"] }) as { read(): number }).read()).toBe(1);
  expect((pickFrom(s, { omit: ["n"] }) as { read(): number }).read()).toBe(1);
});
it("resetStores 는 전부 무른 뒤 다시 짓는다", () => {
  getStore("listener").getState();
  resetStores();
  reaction.mockClear();
  getStore("ev").getState().emit();
  expect(reaction).toHaveBeenCalledTimes(1);
});
