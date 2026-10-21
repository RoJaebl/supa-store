import { beforeEach, expect, it, vi } from "vitest";
import { createStore, getStore, registeredKeys, resetStores } from "./index.js";

declare module "." {
  interface StateTypes {
    "state.test.count": { n: number; add: () => void };
    "state.test.pair": { a: number; b: number; setA: (a: number) => void };
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
  expect(registeredKeys()).toEqual(["state.test.count", "state.test.pair"]);
});
