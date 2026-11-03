// 파생 store — 계산 공간(track)에서 다른 store 를 읽어 값을 짓고, 읽은 것이 바뀌면 다시 짓는다. 훅은 [USE] 안에서만 부른다
import { useSyncExternalStore } from "react";
import { DISPOSE, USE, type Derived } from "./index.js";
import { DERIVED, track, type Channel } from "./track.js";

/**
 * 다른 store 를 ctx 로 읽어 값을 짓는 상태 — `createStore(key, (_s, _g, ctx) => createDerived((prev) => …))`.
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

  const fresh = () => has && reads.every(([c, s]) => Object.is(c.snapshot(), s));
  /** 다시 짓는다. 결과가 앞과 다르면 참 */
  const run = (): boolean => {
    if (computing) throw new Error("파생 store 가 계산 중에 자기 자신을 읽었다");
    computing = true;
    try {
      const r = track(() => compute(has ? value : undefined));
      reads = r.reads.map((c) => [c, c.snapshot()]);
      const changed = !has || !Object.is(r.value, value);
      value = r.value;
      has = true;
      return changed;
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
      const off = c.subscribe(changed);
      const unwatch = c.watch?.();
      held.set(c, () => (off(), unwatch?.()));
    }
  };
  const release = () => {
    held.forEach((stop) => stop());
    held.clear();
  };
  function changed() {
    if (listeners.size === 0 || fresh()) return;
    const differs = run();
    hold();
    if (differs) listeners.forEach((l) => l());
  }

  const get = (): T => {
    // 구독 중이면 changed 가 이미 맞춰 두었다
    if (listeners.size === 0 ? !fresh() : !has) run();
    return value as T;
  };
  const subscribe = (listener: () => void) => {
    if (listeners.size === 0) {
      if (!fresh()) run();
      listeners.add(listener);
      hold();
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
