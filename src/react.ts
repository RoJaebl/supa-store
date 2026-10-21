"use client";
import { useSyncExternalStore } from "react";
import { getStore, type StateKey, type StateOf } from "./index.js";

/** 선택자가 고른 값만 구독한다. 고른 값이 Object.is 로 바뀔 때만 다시 그린다. 서버 렌더는 처음 값이다 */
export function useSharedState<K extends StateKey, U>(key: K, select: (state: StateOf<K>) => U): U {
  const store = getStore(key);
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getInitialState()),
  );
}
