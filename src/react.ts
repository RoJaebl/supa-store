"use client";
import { useRef, useSyncExternalStore } from "react";
import {
  getStore,
  pickFrom,
  USE,
  type Names,
  type Picked,
  type PickOptions,
  type StateKey,
  type StateOf,
} from "./index.js";

type UseKeys = { [K in StateKey]: StateOf<K> extends { [USE]: (...a: any[]) => any } ? K : never }[StateKey];
type UseFn<K> = Extract<StateOf<K>[typeof USE & keyof StateOf<K>], (...a: any[]) => any>;
type Opts = { pick?: readonly string[]; omit?: readonly string[] };

/**
 * key 의 상태를 꺼낸다.
 * - 상태에 [USE] 가 있으면 꺼내기를 그 함수에 맡긴다: useStore(key, ...args) = state[USE](...args)
 * - 없으면 전부, 또는 { pick } / { omit } 으로 고른 칸만. 고른 칸이 (묶기 전 값으로) 그대로면 같은 객체를 돌려준다
 */
export function useStore<K extends UseKeys>(key: K, ...args: Parameters<UseFn<K>>): ReturnType<UseFn<K>>;
export function useStore<K extends StateKey>(key: K): StateOf<K>;
export function useStore<K extends StateKey, N extends Names<K>, O extends PickOptions<K, N>>(
  key: K,
  options: O,
): Picked<K, O>;
export function useStore(key: any, ...args: any[]): any {
  const store = getStore(key as StateKey) as ReturnType<typeof getStore>;
  // [USE] 갈래와 pick 갈래는 key 마다 늘 같은 쪽이라 훅 순서가 바뀌지 않는다
  if (USE in (store.getInitialState() as object)) return (store.getState() as any)[USE](...args);

  const options: Opts = args[0] ?? {};
  const cache = useRef<{ key: string; state: object; names: string[]; raw: unknown[]; out: object } | null>(null);
  const snapshot = (state: object): object => {
    if (!options.pick && !options.omit) return state;
    // key 나 고른 칸 이름이 바뀌었으면 앞 결과를 쓰지 않는다
    const last = cache.current;
    const names = options.pick ? [...options.pick] : Object.keys(state).filter((n) => !options.omit!.includes(n));
    const prev =
      last && last.key === key && last.names.length === names.length && names.every((n, i) => n === last.names[i])
        ? last
        : null;
    if (prev?.state === state) return prev.out;
    const raw = names.map((n) => (state as any)[n]);
    // pickFrom 은 함수 칸을 묶어 매번 새 함수를 만든다 — 묶기 전 값끼리 견줘야 같다고 본다
    if (prev && raw.every((v, i) => Object.is(v, prev.raw[i]))) {
      cache.current = { ...prev, state };
      return prev.out;
    }
    const out = pickFrom(state, { pick: names });
    cache.current = { key, state, names, raw, out };
    return out;
  };
  return useSyncExternalStore(
    store.subscribe,
    () => snapshot(store.getState() as object),
    () => snapshot(store.getInitialState() as object),
  );
}
