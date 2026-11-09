"use client";
import { useRef, useSyncExternalStore } from "react";
import { DISPOSE, getStore, pickFrom, USE, type Names, type Picked, type PickOptions, type Store } from "./index.js";
import type { ResourceUse, ResourceUseOptions, ResourceUseResult } from "./query.js";
import type { StreamUse, StreamUseOptions, StreamUseResult } from "./stream/index.js";

type UseState = { [USE]: (...a: any[]) => any };
type UseFn<S> = Extract<S[typeof USE & keyof S], (...a: any[]) => any>;
// 자원은 옵션의 꼴(하나 · 목록)에 따라 돌려주는 타입이 갈린다 — Parameters · ReturnType 은 제네릭 서명을 제약으로만 읽으므로 따로 받는다
type UseOf<S> = S[typeof USE & keyof S];
// 둘째 자리는 화면이 받는 data — 자원 select 를 거친 S 다. 넷째는 select 전 D
type ResourceTypes<S> = UseOf<S> extends ResourceUse<infer A, infer V, infer R, infer D> ? [A, V, R, D] : never;
// 연결은 [DISPOSE] 로 자원과 가른다 — [USE] 만 보면 연결도 자원 서명에 맞는다
type StreamState = { [USE]: StreamUse<any, any>; [DISPOSE](): void };
type StreamTypes<S> = UseOf<S> extends StreamUse<infer V, infer Cmd> ? [V, Cmd] : never;
type Opts = { pick?: readonly string[]; omit?: readonly string[] };

/**
 * 핸들이 가리키는 store 의 상태를 꺼낸다.
 * - 상태에 [USE] 가 있으면 꺼내기를 그 함수에 맡긴다: useStore(store, ...args) = state[USE](...args)
 * - 없으면 전부, 또는 { pick } / { omit } 으로 고른 칸만. 고른 칸이 (묶기 전 값으로) 그대로면 같은 객체를 돌려준다
 */
export function useStore<S extends StreamState, O extends StreamUseOptions<StreamTypes<S>[0], StreamTypes<S>[1]>>(
  store: Store<S>,
  options?: O,
): StreamUseResult<StreamTypes<S>[0], StreamTypes<S>[1], O>;
export function useStore<
  S extends { [USE]: ResourceUse<any, any, any, any> },
  O extends ResourceUseOptions<ResourceTypes<S>[0], ResourceTypes<S>[1], ResourceTypes<S>[2], ResourceTypes<S>[3]>,
>(store: Store<S>, options?: O): ResourceUseResult<ResourceTypes<S>[1], ResourceTypes<S>[2], O>;
export function useStore<S extends UseState>(store: Store<S>, ...args: Parameters<UseFn<S>>): ReturnType<UseFn<S>>;
export function useStore<S>(store: Store<S>): S;
// [USE] 가 있는 상태는 꺼내기를 [USE] 에 맡긴다 — 이 갈래로 새면 목록의 pick 검사가 빠진다.
// `object &` 를 붙인다 — 칸이 모두 선택인 타입만 두면 겹치는 칸이 없는 상태를 TypeScript 가 받지 않는다
export function useStore<S extends object & { [USE]?: never }, N extends Names<S>, O extends PickOptions<S, N>>(
  store: Store<S>,
  options: O,
): Picked<S, O>;
export function useStore(handle: Store<object>, ...args: any[]): any {
  const store = getStore(handle);
  // [USE] 갈래와 pick 갈래는 store 마다 늘 같은 쪽이라 훅 순서가 바뀌지 않는다
  if (USE in (store.getInitialState() as object)) {
    // 다시 지으면(overrideStore · resetStores) 상태 객체가 바뀐다 — 구독해 두어야 새 상태의 [USE] 로 다시 그린다
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
    return (state as any)[USE](...args);
  }

  const options: Opts = args[0] ?? {};
  const cache = useRef<{ handle: Store<object>; state: object; names: string[]; raw: unknown[]; out: object } | null>(null);
  const snapshot = (state: object): object => {
    if (!options.pick && !options.omit) return state;
    // 핸들이나 고른 칸 이름이 바뀌었으면 앞 결과를 쓰지 않는다
    const last = cache.current;
    const names = options.pick ? [...options.pick] : Object.keys(state).filter((n) => !options.omit!.includes(n));
    const prev =
      last && last.handle === handle && last.names.length === names.length && names.every((n, i) => n === last.names[i])
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
    cache.current = { handle, state, names, raw, out };
    return out;
  };
  return useSyncExternalStore(
    store.subscribe,
    () => snapshot(store.getState() as object),
    () => snapshot(store.getInitialState() as object),
  );
}
