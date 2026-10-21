import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import { createStore, getStore, resetStores } from "./index.js";
import { useSharedState } from "./react.js";

declare module "." {
  interface StateTypes {
    "state.test.count": { n: number; add: () => void };
    "state.test.pair": { a: number; b: number; setA: (a: number) => void };
  }
}

createStore("state.test.count", (set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));
createStore("state.test.pair", (set) => ({ a: 1, b: 2, setA: (a: number) => set({ a }) }));

beforeEach(() => resetStores());

function Probe() {
  return <>{useSharedState("state.test.pair", (s) => s.a)}</>;
}

it("고른 값이 바뀔 때만 다시 그린다", () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useSharedState("state.test.pair", (s) => s.a);
  });
  act(() => getStore("state.test.pair").setState({ b: 99 }));
  expect(renders).toBe(1);
  act(() => getStore("state.test.pair").getState().setA(7));
  expect(result.current).toBe(7);
  expect(renders).toBe(2);
});
it("바꾸는 함수를 고르면 그 함수로 상태를 바꾼다", () => {
  const { result } = renderHook(() => useSharedState("state.test.count", (s) => s.add));
  act(() => result.current());
  expect(getStore("state.test.count").getState().n).toBe(1);
});
it("서버 렌더는 처음 값이다", () => {
  getStore("state.test.pair").getState().setA(42);
  expect(renderToString(<Probe />)).toBe("1");
});
