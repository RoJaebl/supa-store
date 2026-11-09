// 파생 store — 계산 공간(track)에서 다른 store 를 읽어 값을 짓고, 읽은 것이 바뀌면 다시 짓는다. 훅은 [USE] 안에서만 부른다
import { useSyncExternalStore } from "react";
import { DISPOSE, USE, type Derived } from "./index.js";
import { DERIVED, track, type Channel } from "./track.js";

/**
 * 다른 store 를 ctx 로 읽어 값을 짓는 상태 — `const x = createStore((_s, _g, ctx) => createDerived((prev) => …))`.
 *
 * compute 는 계산 공간에서 돈다: 그 안에서 ctx 로 읽은 store(다른 store 의 함수가 자기 ctx 로 읽은 것까지)가 바뀌면
 * 다시 돈다. 구독자가 없으면 따라가지 않고, 꺼낼 때 읽은 것을 견주어 바뀌었으면 그 자리에서 다시 짓는다.
 * 결과가 Object.is 로 앞과 같으면 구독자를 깨우지 않는다. prev 는 앞 결과다(처음이면 undefined).
 */
export function createDerived<T>(compute: (prev: T | undefined) => T): Derived<T> {
  let value: T | undefined;
  let has = false;
  /** 마지막 계산이 읽은 채널과 그때의 스냅숏 */
  let reads: Array<[Channel, unknown]> = [];
  let computing = false;
  const listeners = new Set<() => void>();
  /** 구독자가 있는 동안 건 채널 구독 — 채널 → 푸는 함수 */
  const held = new Map<Channel, () => void>();
  /** 구독자에게 마지막으로 알린 값 — 알림은 이것과 견준다(get 이 먼저 다시 지었어도 알림을 잃지 않는다) */
  let shown: { value: T } | null = null;

  const fresh = () => has && reads.every(([c, s]) => Object.is(c.snapshot(), s));
  const run = () => {
    if (computing) throw new Error("파생 store 가 계산 중에 자기 자신을 읽었다");
    computing = true;
    try {
      const r = track(() => compute(has ? value : undefined));
      reads = r.reads.map((c) => [c, c.snapshot()]);
      value = r.value;
      has = true;
    } finally {
      computing = false;
    }
  };
  /** 걸어 둔 구독을 마지막 계산이 읽은 채널에 맞춘다 — 빠진 것만 풀고 새 것만 건다 */
  const hold = () => {
    const want = new Set(reads.map(([c]) => c));
    held.forEach((stop, c) => want.has(c) || (stop(), held.delete(c)));
    for (const c of want) {
      if (held.has(c)) continue;
      // 채널마다 새 함수를 넘긴다 — 여러 채널이 한 listeners 를 나눠 써도(자원 칸들) 한 칸을 풀 때 다른 칸의 구독이 빠지지 않는다
      const off = c.subscribe(() => changed());
      const unwatch = c.watch?.();
      held.set(c, () => (off(), unwatch?.()));
    }
  };
  const release = () => {
    held.forEach((stop) => stop());
    held.clear();
    shown = null;
  };
  /** 낡았으면 다시 짓고 구독을 맞춘다 */
  const refresh = () => {
    if (fresh()) return;
    run();
    if (listeners.size > 0) hold();
  };
  function changed() {
    if (listeners.size === 0) return;
    refresh();
    if (shown !== null && Object.is(shown.value, value)) return;
    shown = { value: value as T };
    listeners.forEach((l) => l());
  }

  const get = (): T => {
    if (computing) throw new Error("파생 store 가 계산 중에 자기 자신을 읽었다");
    // 구독 중이어도 읽은 것이 바뀌었으면 여기서 다시 짓는다 — 알림 차례에 따라 중간값을 보이지 않게
    refresh();
    return value as T;
  };
  const subscribe = (listener: () => void) => {
    if (listeners.size === 0) {
      listeners.add(listener);
      refresh();
      hold();
      shown = { value: value as T };
    } else listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) release();
    };
  };
  const channel: Channel = { subscribe, snapshot: get };

  return {
    get,
    subscribe,
    [USE]: () => useSyncExternalStore(subscribe, get, get),
    [DISPOSE]: release,
    [DERIVED]: channel,
  };
}
