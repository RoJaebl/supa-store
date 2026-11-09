import { beforeEach, expect, it, vi } from "vitest";
import { createStore, currentBuild, DISPOSE, disposeStores, getStore, overrideStore, pickFrom, registeredStores, resetStores, type Store } from "./index.js";

const count = createStore<{ n: number; add: () => void }>((set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));
const pair = createStore<{ a: number; b: number; setA: (a: number) => void }>((set) => ({ a: 1, b: 2, setA: (a: number) => set({ a }) }));

beforeEach(() => resetStores());

it("등록하면 곧 읽힌다", () => {
  expect(getStore(count).getState().n).toBe(0);
});
it("setState 는 얕게 합치고 나머지 필드를 남긴다", () => {
  getStore(pair).getState().setA(5);
  expect(getStore(pair).getState()).toMatchObject({ a: 5, b: 2 });
});
it("함수 꼴 setState 가 지금 값을 받는다", () => {
  getStore(pair).setState((now) => ({ b: now.b * 10 }));
  expect(getStore(pair).getState().b).toBe(20);
});
it("같은 객체를 돌려주면 구독자를 부르지 않는다", () => {
  const store = getStore(pair);
  let calls = 0;
  store.subscribe(() => calls++);
  store.setState((now) => now);
  expect(calls).toBe(0);
});
it("구독을 풀면 더 부르지 않는다", () => {
  const store = getStore(count);
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.getState().add();
  off();
  store.getState().add();
  expect(calls).toBe(1);
});
it("resetStores 뒤에는 처음 값이고 구독자는 남아 알림을 받는다", () => {
  const store = getStore(count);
  let calls = 0;
  store.subscribe(() => calls++);
  store.getState().add();
  resetStores();
  expect(store.getState().n).toBe(0);
  expect(store.getInitialState().n).toBe(0);
  expect(calls).toBe(2);
});
it("registeredStores 는 등록한 차례대로 핸들을 준다", () => {
  const x = createStore(() => ({}));
  const y = createStore(() => ({}));
  const all = registeredStores();
  expect(all.indexOf(x)).toBeLessThan(all.indexOf(y));
  expect(all.indexOf(count)).toBeLessThan(all.indexOf(x));
});
it("getStore 는 핸들이 아니면 던진다", () => {
  expect(() => getStore("state.test.count" as never)).toThrow("store 핸들이 아니다");
});
it("같은 creator 로 두 번 부르면 서로 다른 store 다", () => {
  const make = () => ({ n: 0 });
  const p = createStore(make);
  const q = createStore(make);
  getStore(p).setState({ n: 1 });
  expect(getStore(q).getState().n).toBe(0);
});
it("순환 오류에 두 store 의 이름이 부른 자리 꼴로 선다", () => {
  const a: Store<{ n: number }> = createStore((_s, _g, ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore((_s, _g, ctx) => ({ n: ctx(a).n }));
  expect(() => getStore(a).getState()).toThrow(/순환한다: .*index\.test\.ts:\d+ → .*index\.test\.ts:\d+ → .*index\.test\.ts:\d+/);
});
it("배포 모드에서는 이름이 #<n> 이다", () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    const a: Store<{ n: number }> = createStore((_s, _g, ctx) => ({ n: ctx(a).n }));
    expect(() => getStore(a).getState()).toThrow(/순환한다: #\d+ → #\d+/);
  } finally {
    vi.unstubAllEnvs();
  }
});

// --- 2단계: ctx · 처음 꺼낼 때 짓기 · overrideStore · pick/omit ---

const built = vi.fn();
const lazyBuilt = createStore(() => {
  built();
  return { n: 0 };
});
const source = createStore(() => ({ n: 1, m: 2 }));
const reader = createStore<{ read: () => number; picked: () => object }>((_set, _get, ctx) => ({
  read: () => ctx(source).n,
  picked: () => ctx(source, { pick: ["n"] }),
}));
const first = createStore<{ n: number }>((_set, _get, ctx) => ({ n: ctx(second).n + 1 }));
const second = createStore(() => ({ n: 1 }));
const infra = createStore(() => ({ v: "real" }));
const infraReader = createStore<{ read: () => string }>((_set, _get, ctx) => ({ read: () => ctx(infra).v }));

const reaction = vi.fn();
function makeEvent() {
  const listeners = new Set<() => void>();
  return { on: (f: () => void) => void listeners.add(f), emit: () => listeners.forEach((f) => f()) };
}
const ev = createStore(makeEvent);
const listener = createStore((_set, _get, ctx) => {
  ctx(ev).on(reaction);
  return {};
});

it("등록만 하면 짓지 않는다", () => {
  expect(built).toHaveBeenCalledTimes(0);
  getStore(lazyBuilt).getState();
  expect(built).toHaveBeenCalledTimes(1);
});
it("ctx(handle) 는 부르는 순간의 값을 준다", () => {
  const { read } = getStore(reader).getState();
  getStore(source).setState({ n: 2 });
  expect(read()).toBe(2);
});
it("ctx(handle, { pick }) 는 고른 칸만 준다", () => {
  expect(Object.keys(getStore(reader).getState().picked())).toEqual(["n"]);
});
it("등록 순서와 상관없이 짓는 순간 다른 store 를 꺼낸다", () => {
  expect(() => getStore(first).getState()).not.toThrow();
  expect(getStore(first).getState().n).toBe(2);
});
it("overrideStore 는 처음 정의 대신 짓고, resetStores 가 되돌린다", () => {
  const { read } = getStore(infraReader).getState();
  overrideStore(infra, () => ({ v: "fake" }));
  expect(read()).toBe("fake");
  resetStores();
  expect(getStore(infraReader).getState().read()).toBe("real");
});
it("ctx(handle) 로 기댄 store 는 기댄 store 를 overrideStore 하면 다시 지어진다", () => {
  getStore(listener).getState();
  reaction.mockClear();
  overrideStore(ev, makeEvent);
  getStore(ev).getState().emit();
  expect(reaction).toHaveBeenCalledTimes(1);
});
it("getStore(handle) 은 overrideStore · resetStores · disposeStores 뒤에도 같은 객체이고 구독이 남는다", () => {
  const before = getStore(infra);
  let calls = 0;
  before.subscribe(() => calls++);
  getStore(infra).getState();
  overrideStore(infra, () => ({ v: "fake" }));
  expect(getStore(infra)).toBe(before);
  resetStores();
  expect(getStore(infra)).toBe(before);
  disposeStores();
  expect(getStore(infra)).toBe(before);
  expect(calls).toBe(2);
  before.setState({ v: "set" });
  expect(calls).toBe(3);
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
  getStore(listener).getState();
  resetStores();
  reaction.mockClear();
  getStore(ev).getState().emit();
  expect(reaction).toHaveBeenCalledTimes(1);
});

// [DISPOSE] — 상태에 달린 정리 함수
it("dispose: 기호는 USE 와 같은 꼴의 Symbol.for(\"supa-store.dispose\") 다", () => {
  expect(DISPOSE).toBe(Symbol.for("supa-store.dispose"));
});
const disposers: Array<ReturnType<typeof vi.fn>> = [];
const disposeA = createStore(() => {
  const fn = vi.fn();
  disposers.push(fn);
  return { n: 0, [DISPOSE]: fn };
});
const disposePlain = createStore(() => ({ n: 0 }));
const readerDisposers: Array<ReturnType<typeof vi.fn>> = [];
const disposeReader = createStore<{ read: () => number; n: number }>((_set, _get, ctx) => {
  const fn = vi.fn();
  readerDisposers.push(fn);
  const src = ctx(disposeA);
  return { n: 0, read: () => (src as { n: number }).n, [DISPOSE]: fn };
});

it("dispose: 다시 지을 때 앞 상태의 [DISPOSE] 를 한 번 부른다", () => {
  disposeStores();
  disposers.length = 0;
  getStore(disposeA).getState();
  overrideStore(disposeA, () => ({ n: 1 }));
  expect(disposers).toHaveLength(1);
  expect(disposers[0]).toHaveBeenCalledTimes(1);
});
it("dispose: resetStores 도 앞 [DISPOSE] 를 부르고 곧바로 다시 짓는다", () => {
  disposeStores();
  disposers.length = 0;
  getStore(disposeA).getState();
  resetStores();
  expect(disposers[0]).toHaveBeenCalledTimes(1);
  expect(disposers).toHaveLength(2);
});
it("dispose: disposeStores 는 [DISPOSE] 를 부르고 다시 짓지 않는다 — 다음 getState 때 새로 짓는다", () => {
  disposeStores();
  disposers.length = 0;
  getStore(disposeA).getState();
  disposeStores();
  expect(disposers[0]).toHaveBeenCalledTimes(1);
  expect(disposers).toHaveLength(1);
  getStore(disposeA).getState();
  expect(disposers).toHaveLength(2);
  expect(disposers[0]).toHaveBeenCalledTimes(1);
});
it("dispose: [DISPOSE] 가 던져도 다시 짓기는 이어진다", () => {
  disposeStores();
  disposers.length = 0;
  getStore(disposeA).getState();
  disposers[0]!.mockImplementation(() => {
    throw new Error("boom");
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => resetStores()).not.toThrow();
  expect(err).toHaveBeenCalledTimes(1);
  err.mockRestore();
  expect(disposers).toHaveLength(2);
  expect(getStore(disposeA).getState().n).toBe(0);
});
it("dispose: [DISPOSE] 가 없는 0.2 의 상태는 그대로다", () => {
  getStore(disposePlain).setState({ n: 5 });
  resetStores();
  expect(getStore(disposePlain).getState().n).toBe(0);
  expect(() => disposeStores()).not.toThrow();
});
it("dispose: ctx 로 읽은 store 가 다시 지어지면 읽던 store 의 [DISPOSE] 도 부른다", () => {
  disposeStores();
  readerDisposers.length = 0;
  getStore(disposeReader).getState();
  overrideStore(disposeA, () => ({ n: 9 }));
  expect(readerDisposers[0]).toHaveBeenCalledTimes(1);
  expect(readerDisposers).toHaveLength(2);
});
it("ctx() 는 짓기가 끝난 뒤 자기 상태를 준다", () => {
  let self: () => unknown = () => null;
  const self_ = createStore((_set, _get, ctx) => ({ n: 1, read: () => (self = () => ctx(), ctx()) }));
  const state = getStore(self_).getState() as any;
  expect(state.read()).toBe(state);
  expect(self()).toBe(getStore(self_).getState());
});
it("짓는 동안 ctx() 를 부르면 정해진 문구로 실패한다", () => {
  const early = createStore((_set, _get, ctx) => ({ n: (ctx() as any).n }));
  expect(() => getStore(early).getState()).toThrow(/^짓는 동안에는 자기 자신을 꺼낼 수 없다: .*index\.test\.ts:\d+$/);
});

// currentBuild — 짓는 동안 건 것을 그 store 의 dispose 에 맡긴다(event 가 쓴다)
it("currentBuild 는 짓는 공간 밖에서 undefined 다", () => {
  expect(currentBuild()).toBeUndefined();
});
it("adopt 한 함수는 dispose 때 [DISPOSE] 뒤에 돌고, [DISPOSE] 가 던져도 돈다", () => {
  const order: string[] = [];
  let label = "";
  let fail = false;
  const adopter = createStore(() => {
    const build = currentBuild()!;
    label = build.label;
    build.adopt(() => order.push("off"));
    return {
      [DISPOSE]: () => {
        order.push("dispose");
        if (fail) throw new Error("boom");
      },
    };
  });
  getStore(adopter).getState();
  expect(label).toMatch(/index\.test\.ts:\d+$/);
  disposeStores();
  expect(order).toEqual(["dispose", "off"]);
  // 떼고 나면 비운다 — 다시 지으면 새로 건 것만 돈다
  getStore(adopter).getState();
  fail = true;
  order.length = 0;
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  disposeStores();
  err.mockRestore();
  expect(order).toEqual(["dispose", "off"]);
});
