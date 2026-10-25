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
const selectResource = () =>
  createResource(() => ({ query: async (a: { id: number }) => ({ title: `t${a.id}` }) }), {
    select: (d, a) => `${a.id}:${d.title}`,
  });
declare module "./index.js" {
  interface StateTypes {
    "api.types.list": ReturnType<typeof listResource>;
    "api.types.select": ReturnType<typeof selectResource>;
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

it("타입: 자원 select 의 결과가 화면 data 로, 화면 select 의 결과가 그 위로, getData 는 서버 모양 그대로", () => {
  const one = () => useStore("api.types.select", { args: { id: 1 } });
  expectTypeOf<ReturnType<typeof one>["data"]>().toEqualTypeOf<string | undefined>();
  const screen = () => useStore("api.types.select", { args: { id: 1 }, select: (s, a) => s.length + a.id });
  expectTypeOf<ReturnType<typeof screen>["data"]>().toEqualTypeOf<number | undefined>();
  const list = () => useStore("api.types.select", { args: ids(1), pick: ["data"], select: (s) => s.length > 0 });
  expectTypeOf<ReturnType<typeof list>>().toEqualTypeOf<Array<{ data: boolean | undefined }>>();
  const got = () => selectResource().getData({ id: 1 });
  expectTypeOf<ReturnType<typeof got>>().toEqualTypeOf<{ title: string } | undefined>();
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
it("pick: 겉 칸을 견주는 것은 배열과 보통 객체뿐 — Date · Map 은 새 값이면 바뀐 것이다", async () => {
  const key = define(() => createResource(() => ({ query: async () => new Date(0) as Date | Map<number, number> })));
  const { result } = renderHook(() => view(key, { pick: ["data"] }));
  await flush();
  act(() => state(key).setData(new Date(1)));
  expect(result.current.data).toEqual(new Date(1));
  act(() => state(key).setData(new Map([[1, 2]])));
  act(() => state(key).setData(new Map([[1, 3]])));
  expect(result.current.data.get(1)).toBe(3);
});

// ── select ────────────────────────────────────────────

type Post = { title: string; updatedAt: number };
const posts = (select?: (d: Post) => unknown) => {
  const key = define(() =>
    createResource(() => ({ query: async (): Promise<Post> => ({ title: "hi", updatedAt: 0 }) }), { select }),
  );
  return key;
};
const counted = (key: string, options?: () => object) => {
  let renders = 0;
  const hook = renderHook(() => {
    renders++;
    return view(key, options?.());
  });
  return { ...hook, renders: () => renders };
};

it("select: 자원의 select 는 화면에만 걸리고 getData 는 서버 모양 그대로다", async () => {
  const key = posts((d) => d.title.toUpperCase());
  const { result } = renderHook(() => view(key));
  await flush();
  expect(result.current.data).toBe("HI");
  expect(state(key).getData()).toEqual({ title: "hi", updatedAt: 0 });
  await expect(state(key).fetch()).resolves.toEqual({ title: "hi", updatedAt: 0 });
});
it("select: 화면의 select 는 자원 select 의 결과를 이어 받는다", async () => {
  const key = posts((s) => s.title.toUpperCase());
  const { result } = renderHook(() => view(key, { select: (t: string) => `${t}!`.length }));
  await flush();
  expect(result.current.data).toBe(3);
});
it("select: 결과가 같으면 data 가 새 객체여도 다시 그리지 않는다", async () => {
  const key = posts((d) => d.title);
  const { result, renders } = counted(key);
  await flush();
  const before = renders();
  const shown = result.current;
  act(() => state(key).setData({ title: "hi", updatedAt: 1 }));
  expect(renders()).toBe(before);
  expect(result.current).toBe(shown);
});
it("select: 객체를 돌려주면 겉 칸이 같을 때 앞 객체를 그대로 준다", async () => {
  const key = posts((d) => ({ title: d.title }));
  const { result, renders } = counted(key);
  await flush();
  const before = renders();
  const data = result.current.data;
  act(() => state(key).setData({ title: "hi", updatedAt: 1 }));
  expect(renders()).toBe(before);
  expect(result.current.data).toBe(data);
  act(() => state(key).setData({ title: "yo", updatedAt: 2 }));
  expect(result.current.data).toEqual({ title: "yo" });
});
it("select: 렌더마다 새 함수를 줘도 결과가 같으면 다시 그리지 않는다", async () => {
  const key = posts();
  const { result, renders, rerender } = counted(key, () => ({ select: (d: Post) => ({ title: d.title }) }));
  await flush();
  const shown = result.current;
  rerender();
  expect(result.current).toBe(shown);
  const before = renders();
  act(() => state(key).setData({ title: "hi", updatedAt: 1 }));
  expect(renders()).toBe(before);
  expect(result.current).toBe(shown);
});
it("select: 목록 꼴에서 항목마다 (data, args) 로 불린다", async () => {
  const resource = vi.fn((d: number, a: { id: number }) => `${a.id}:${d}`);
  const key = define(() => createResource(() => ({ query: async (a: { id: number }) => a.id * 10 }), { select: resource }));
  const { result } = renderHook(() =>
    view(key, { args: ids(1, 2), pick: ["data"], select: (s: string, a: { id: number }) => `${s}@${a.id}` }),
  );
  await flush();
  expect(result.current).toEqual([{ data: "1:10@1" }, { data: "2:20@2" }]);
  expect(resource).toHaveBeenCalledWith(10, { id: 1 });
  expect(resource).toHaveBeenCalledWith(20, { id: 2 });
});

type Feed = { items: { id: number; at: number }[] };
const fresh = (d: Feed) => d.items.map((x) => ({ id: x.id }));
const feed = (select?: (d: Feed) => unknown) =>
  define(() =>
    createResource(() => ({ query: async (a?: { id: number }): Promise<Feed> => ({ items: [{ id: a?.id ?? 0, at: 0 }] }) }), {
      select,
    }),
  );
it("select: 겉 칸이 매번 새 객체인 결과여도 받은 값이 그대로면 앞 결과를 준다 — 하나 꼴", async () => {
  const key = feed(fresh);
  const { result, renders, rerender } = counted(key, () => ({ args: { id: 1 }, select: (s: { id: number }[]) => s.map((x) => ({ ...x })) }));
  await flush();
  expect(result.current.data).toEqual([{ id: 1 }]);
  const before = renders();
  // 다른 칸이 바뀌어 알림만 오면 다시 그리지 않는다
  act(() => state(key).setData({ items: [] }, { id: 9 }));
  expect(renders()).toBe(before);
  // 렌더마다 새 화면 select 면 그 렌더에서 한 번만 다시 만든다
  rerender();
  expect(renders()).toBe(before + 1);
});
it("select: 겉 칸이 매번 새 객체인 결과여도 받은 값이 그대로면 앞 결과를 준다 — 목록 꼴", async () => {
  const key = feed(fresh);
  const { result, renders } = counted(key, () => ({ args: ids(1, 2), pick: ["data"] }));
  await flush();
  const shown = result.current;
  expect(shown).toEqual([{ data: [{ id: 1 }] }, { data: [{ id: 2 }] }]);
  const before = renders();
  act(() => state(key).setData({ items: [] }, { id: 9 }));
  expect(renders()).toBe(before);
  expect(result.current).toBe(shown);
});
