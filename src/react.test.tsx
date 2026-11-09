import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import { createStore, getStore, resetStores, USE } from "./index.js";
import { useStore } from "./react.js";

type Count = { n: number; add: () => void };
type Pair = { a: number; b: number; setA: (a: number) => void };

const count = createStore<Count>((set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));
const pairS = createStore<Pair>((set) => ({ a: 1, b: 2, setA: (a: number) => set({ a }) }));

const pair2 = createStore<Pair>((set) => ({ a: 1, b: 2, setA: (a: number) => set({ a }) }));
const useS = createStore(() => ({ [USE]: (x: number) => x * 2 }));
const pair = () => getStore(pairS);

beforeEach(() => resetStores());

it("useStore: 인자 없이 꺼내면 상태 전부", () => {
  const { result } = renderHook(() => useStore(count));
  act(() => result.current.add());
  expect(result.current.n).toBe(1);
});
it("useStore: pick 은 고른 칸이 바뀔 때만 다시 그린다 (묶인 함수를 골라도 무한히 그리지 않는다)", () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useStore(pairS, { pick: ["a", "setA"] });
  });
  expect(renders).toBe(1);
  act(() => pair().setState({ b: 99 }));
  expect(renders).toBe(1);
  act(() => result.current.setA(5));
  expect(result.current.a).toBe(5);
  expect(renders).toBe(2);
});
it("useStore: omit 은 뺀 칸이 바뀌어도 다시 그리지 않는다", () => {
  let renders = 0;
  renderHook(() => {
    renders += 1;
    return useStore(pairS, { omit: ["b"] });
  });
  act(() => pair().setState({ b: 99 }));
  expect(renders).toBe(1);
  act(() => pair().setState({ a: 3 }));
  expect(renders).toBe(2);
});
it("useStore: pick 결과는 칸이 같으면 같은 참조다", () => {
  const { result, rerender } = renderHook(() => useStore(pairS, { pick: ["a", "setA"] }));
  const first = result.current;
  act(() => pair().setState({ b: 99 }));
  rerender();
  expect(result.current).toBe(first);
});
it("useStore: 상태가 그대로여도 pick 이 바뀌면 새 칸을 준다", () => {
  const { result, rerender } = renderHook(({ pick }) => useStore(pairS, { pick }), {
    initialProps: { pick: ["a"] as ("a" | "b")[] },
  });
  expect(Object.keys(result.current)).toEqual(["a"]);
  rerender({ pick: ["b"] });
  expect(Object.keys(result.current)).toEqual(["b"]);
});
it("useStore: 핸들이 바뀌면 칸 값이 같아도 새 store 의 것을 준다", () => {
  const { result, rerender } = renderHook(
    ({ k }) => useStore(k, { pick: ["a", "b"] }),
    { initialProps: { k: pairS } },
  );
  const first = result.current;
  rerender({ k: pair2 });
  expect(result.current).not.toBe(first);
});
it("useStore: 표식이 있으면 꺼내기를 맡긴다", () => {
  const { result } = renderHook(() => useStore(useS, 3));
  expect(result.current).toBe(6);
});
it("useStore: 서버 렌더는 처음 값이다", () => {
  pair().getState().setA(42);
  function P() {
    return <>{useStore(pairS, { pick: ["a"] }).a}</>;
  }
  expect(renderToString(<P />)).toBe("1");
});
