import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, getStore, resetStores } from "./index.js";
import { createResource, type QueryView } from "./query.js";
import { useStore } from "./react.js";

beforeEach(() => resetStores());

let n = 0;
function define(creator: () => object): string {
  const key = `api.hook.r${++n}`;
  createStore(key, creator);
  return key;
}
const view = (key: string, options?: object): any => (useStore as any)(key, options);
const state = (key: string): any => getStore(key as never).getState();
const flush = () => act(async () => {});

/** 부를 때마다 새 약속을 내주고, 시험이 차례대로 풀게 한다 */
function controlled<T>() {
  const calls: Array<{ args: any; resolve: (value: T) => void }> = [];
  const fn = vi.fn((args?: unknown) => new Promise<T>((resolve) => calls.push({ args, resolve })));
  return { fn, calls };
}
const byId = () => {
  const q = controlled<number>();
  const key = define(() => createResource(() => ({ query: (a: { id: number }) => q.fn(a), save: async () => 1 })));
  return { q, key };
};
const ids = (...list: number[]) => list.map((id) => ({ id }));

// ── 타입 ──────────────────────────────────────────────

const listResource = () =>
  createResource(() => ({
    query: async (a: { id: number }) => a.id,
    async save(value: number) {
      return value;
    },
  }));
declare module "./index.js" {
  interface StateTypes {
    "api.types.list": ReturnType<typeof listResource>;
  }
}
it("타입: 목록 꼴은 고른 조회 칸의 배열을, 하나 꼴은 고른 칸을 준다", () => {
  // 부르지 않는다 — 훅 바깥이라 타입만 본다
  const list = () => useStore("api.types.list", { args: ids(1), pick: ["data", "status"] });
  expectTypeOf<ReturnType<typeof list>>().toEqualTypeOf<Array<Pick<QueryView<number>, "data" | "status">>>();
  const listAll = () => useStore("api.types.list", { args: ids(1) });
  expectTypeOf<ReturnType<typeof listAll>>().toEqualTypeOf<QueryView<number>[]>();
  const all = () => useStore("api.types.list");
  type View = ReturnType<typeof all>;
  expectTypeOf<View["data"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<View["isPlaceholderData"]>().toEqualTypeOf<boolean>();
  expectTypeOf<View["save"]["mutateAsync"]>().returns.resolves.toEqualTypeOf<number>();
  const one = () => useStore("api.types.list", { args: { id: 1 }, pick: ["data", "save"] });
  expectTypeOf<ReturnType<typeof one>>().toEqualTypeOf<Pick<View, "data" | "save">>();
  // @ts-expect-error 목록의 pick 에는 바꾸기 이름을 적지 못한다
  void (() => useStore("api.types.list", { args: ids(1), pick: ["save"] }));
});

// ── 목록 ──────────────────────────────────────────────

it("목록: args 배열이면 같은 순서의 조회 칸 배열을 준다", async () => {
  const { q, key } = byId();
  const { result } = renderHook(() => view(key, { args: ids(1, 2) }));
  expect(q.calls.map((c) => c.args)).toEqual(ids(1, 2));
  await act(async () => q.calls.forEach((c) => c.resolve(c.args.id * 10)));
  expect(result.current).toEqual([
    { data: 10, status: "ready", error: null, isPlaceholderData: false, refetch: expect.any(Function) },
    { data: 20, status: "ready", error: null, isPlaceholderData: false, refetch: expect.any(Function) },
  ]);
});
it("목록: 하나 꼴 화면과 목록 꼴 화면이 같은 args 의 요청 하나를 나눠 쓴다", async () => {
  const { q, key } = byId();
  const one = renderHook(() => view(key, { args: { id: 1 } }));
  const list = renderHook(() => view(key, { args: ids(1) }));
  expect(q.fn).toHaveBeenCalledTimes(1);
  await act(async () => q.calls[0]!.resolve(10));
  expect(one.result.current.data).toBe(10);
  expect(list.result.current[0].data).toBe(10);
});
it("목록: 같은 args 가 두 번 들면 요청은 하나, 결과에는 두 번", async () => {
  const { q, key } = byId();
  const { result } = renderHook(() => view(key, { args: ids(1, 1) }));
  expect(q.fn).toHaveBeenCalledTimes(1);
  await act(async () => q.calls[0]!.resolve(10));
  expect(result.current.map((v: any) => v.data)).toEqual([10, 10]);
});
it("목록: 렌더마다 map 으로 새 배열을 줘도 다시 받지 않는다", async () => {
  const { q, key } = byId();
  const { rerender } = renderHook(() => view(key, { args: [1, 2].map((id) => ({ id })) }));
  rerender();
  rerender();
  rerender();
  expect(q.fn).toHaveBeenCalledTimes(2);
});
it("목록: 길이가 바뀌어도 훅 순서가 깨지지 않고 새 항목만 받는다", async () => {
  const { q, key } = byId();
  const { result, rerender } = renderHook(({ list }) => view(key, { args: ids(...list) }), {
    initialProps: { list: [1] },
  });
  await act(async () => q.calls[0]!.resolve(10));
  rerender({ list: [1, 2, 3] });
  expect(q.calls.map((c) => c.args.id)).toEqual([1, 2, 3]);
  await act(async () => q.calls.slice(1).forEach((c) => c.resolve(c.args.id * 10)));
  expect(result.current.map((v: any) => v.data)).toEqual([10, 20, 30]);
  rerender({ list: [3] });
  expect(result.current.map((v: any) => v.data)).toEqual([30]);
  expect(q.fn).toHaveBeenCalledTimes(3);
});
it("목록: 빈 배열이면 [] 를 주고 받지 않는다", () => {
  const { q, key } = byId();
  const { result } = renderHook(() => view(key, { args: [] }));
  expect(result.current).toEqual([]);
  expect(q.fn).not.toHaveBeenCalled();
});
it("목록: 하나 꼴과 목록 꼴을 렌더마다 오가도 훅 순서 오류가 없다", async () => {
  const { q, key } = byId();
  const { result, rerender } = renderHook(({ list }) => view(key, { args: list ? ids(1) : { id: 1 } }), {
    initialProps: { list: false },
  });
  await act(async () => q.calls[0]!.resolve(10));
  expect(result.current).toMatchObject({ data: 10, save: { pending: false } });
  rerender({ list: true });
  expect(result.current).toMatchObject([{ data: 10 }]);
  expect(result.current[0]).not.toHaveProperty("save");
  rerender({ list: false });
  expect(result.current.data).toBe(10);
  expect(q.fn).toHaveBeenCalledTimes(1);
});

// ── pick 견주기 ────────────────────────────────────────

it("pick: 자원에서 pick: [\"data\"] 면 status 만 바뀔 때 다시 그리지 않는다", async () => {
  const q = controlled<{ n: number }>();
  const key = define(() => createResource(() => ({ query: () => q.fn() })));
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return view(key, { pick: ["data"] });
  });
  await act(async () => q.calls[0]!.resolve({ n: 1 }));
  const shown = result.current;
  expect(shown).toEqual({ data: { n: 1 } });
  const before = renders;
  // loading 을 거쳐 겉 칸이 같은 새 객체가 와도 그대로다
  await act(async () => {
    const done = state(key).invalidate();
    q.calls[1]!.resolve({ n: 1 });
    await done;
  });
  expect(renders).toBe(before);
  expect(result.current).toBe(shown);
  await act(async () => {
    const done = state(key).invalidate();
    q.calls[2]!.resolve({ n: 2 });
    await done;
  });
  expect(result.current).toEqual({ data: { n: 2 } });
});
it("pick: 아무 항목도 바뀌지 않으면 목록은 앞 배열을 그대로, 바뀐 항목만 새 객체", async () => {
  const { q, key } = byId();
  const { result, rerender } = renderHook(() => view(key, { args: ids(1, 2), pick: ["data"] }));
  await act(async () => q.calls.forEach((c) => c.resolve(c.args.id * 10)));
  const first = result.current;
  rerender();
  expect(result.current).toBe(first);
  act(() => state(key).setData(11, { id: 1 }));
  const second = result.current;
  expect(second).not.toBe(first);
  expect(second[0]).toEqual({ data: 11 });
  expect(second[1]).toBe(first[1]);
  await act(async () => {
    const done = state(key).invalidate(ids(1, 2));
    q.calls.slice(2).forEach((c) => c.resolve(c.args.id === 1 ? 11 : 20));
    await done;
  });
  expect(result.current).toBe(second);
});
