import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { createStore, getStore, resetStores } from "./index.js";
import { createResource, keepPreviousData, type Prev, type QueryView } from "./query.js";
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
  const calls: Array<{ args: any; resolve: (value: T) => void; reject: (e: Error) => void }> = [];
  const fn = vi.fn((args?: unknown) => new Promise<T>((resolve, reject) => calls.push({ args, resolve, reject })));
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
  const filled = () => useStore("api.types.select", { args: { id: 1 }, placeholderData: keepPreviousData });
  expectTypeOf<ReturnType<typeof filled>["data"]>().toEqualTypeOf<string | undefined>();
  // 화면의 자리 채우기는 select 전 모양 D 를 짓는다
  void (() => useStore("api.types.select", { args: ids(1), placeholderData: (a) => ({ title: `p${a.id}` }) }));
  void (() =>
    useStore("api.types.select", { args: { id: 1 }, placeholderData: keepPreviousData((a, p) => p.args.id === a.id) }));
  // @ts-expect-error 자리를 채우는 값은 select 전 모양이어야 한다
  void (() => useStore("api.types.select", { args: { id: 1 }, placeholderData: "x" }));
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

// ── 자리 채우기 ────────────────────────────────────────

it("자리 채우기: 처음 열면 화면의 지어낸 값을 보이고 isPlaceholderData 가 true", async () => {
  const { q, key } = byId();
  const { result } = renderHook(() => view(key, { args: { id: 1 }, placeholderData: 7 }));
  expect(result.current).toMatchObject({ data: 7, status: "loading", isPlaceholderData: true });
  expect(state(key).getData({ id: 1 })).toBeUndefined();
  await act(async () => q.calls[0]!.resolve(10));
  expect(result.current).toMatchObject({ data: 10, status: "ready", isPlaceholderData: false });
});
it("자리 채우기: 자원 함수가 undefined 면 화면 값을 따른다", () => {
  const key = define(() =>
    createResource(() => ({ query: (a: { id: number }) => new Promise<number>(() => void a) }), {
      placeholderData: (a: { id: number }) => (a.id === 1 ? 100 : undefined),
    }),
  );
  const { result } = renderHook(() => view(key, { args: ids(1, 2), pick: ["data"], placeholderData: 5 }));
  expect(result.current).toEqual([{ data: 100 }, { data: 5 }]);
});
it("자리 채우기: 새 args 가 실패해도 채운 값이 남고 status 는 error", async () => {
  const { q, key } = byId();
  const { result, rerender } = renderHook(({ id }) => view(key, { args: { id }, placeholderData: keepPreviousData }), {
    initialProps: { id: 1 },
  });
  await act(async () => q.calls[0]!.resolve(10));
  rerender({ id: 2 });
  await act(async () => q.calls[1]!.reject(new Error("없다")));
  expect(result.current).toMatchObject({ data: 10, status: "error", error: "없다", isPlaceholderData: true });
});
it("자리 채우기: 화면끼리 영향이 없다 — 한 화면이 채워도 다른 화면 data 는 undefined", () => {
  const { key } = byId();
  const filled = renderHook(() => view(key, { args: { id: 1 }, placeholderData: 7 }));
  const plain = renderHook(() => view(key, { args: { id: 1 } }));
  expect(filled.result.current.data).toBe(7);
  expect(plain.result.current).toMatchObject({ data: undefined, isPlaceholderData: false });
});
it("keepPreviousData 꼴 1 하나: args 가 무엇으로 바뀌든 앞 값을 잇는다", async () => {
  const { q, key } = byId();
  const { result, rerender } = renderHook(({ id }) => view(key, { args: { id }, placeholderData: keepPreviousData }), {
    initialProps: { id: 1 },
  });
  expect(result.current).toMatchObject({ data: undefined, isPlaceholderData: false });
  await act(async () => q.calls[0]!.resolve(10));
  rerender({ id: 2 });
  expect(result.current).toMatchObject({ data: 10, status: "loading", isPlaceholderData: true });
  rerender({ id: 99 });
  expect(result.current).toMatchObject({ data: 10, isPlaceholderData: true });
  await act(async () => q.calls[2]!.resolve(990));
  expect(result.current).toMatchObject({ data: 990, isPlaceholderData: false });
});
it("keepPreviousData 꼴 1 목록: 끼어든 항목은 undefined 이고 옆 값이 밀려오지 않는다", async () => {
  const { q, key } = byId();
  const { result, rerender } = renderHook(
    ({ list }) => view(key, { args: ids(...list), pick: ["data", "isPlaceholderData"], placeholderData: keepPreviousData }),
    { initialProps: { list: [1, 2] } },
  );
  await act(async () => q.calls.forEach((c) => c.resolve(c.args.id * 10)));
  rerender({ list: [1, 3, 2] });
  expect(result.current).toEqual([
    { data: 10, isPlaceholderData: false },
    { data: undefined, isPlaceholderData: false },
    { data: 20, isPlaceholderData: false },
  ]);
  // 받은 값을 비우면 같은 args 의 앞 값으로 채운다
  act(() => state(key).setData(undefined, { id: 2 }));
  expect(result.current[1]).toEqual({ data: undefined, isPlaceholderData: false });
  expect(result.current[2]).toEqual({ data: 20, isPlaceholderData: true });
});
it("keepPreviousData 꼴 2: match 가 참인 앞 항목을 잇는다", async () => {
  const q = controlled<string>();
  type Path = { repo: string; path: string };
  const key = define(() => createResource(() => ({ query: (a: Path) => q.fn(a) })));
  const sameRepo = keepPreviousData((a: Path, p: { args: Path }) => p.args.repo === a.repo);
  const at = (repo: string, path: string) => ({ repo, path });
  const { result, rerender } = renderHook(
    ({ list }) => view(key, { args: list, pick: ["data", "isPlaceholderData"], placeholderData: sameRepo }),
    { initialProps: { list: [at("r1", "a"), at("r2", "x")] } },
  );
  await act(async () => q.calls.forEach((c) => c.resolve(c.args.path.toUpperCase())));
  rerender({ list: [at("r2", "y"), at("r1", "b"), at("r3", "z")] });
  expect(result.current).toEqual([
    { data: "X", isPlaceholderData: true },
    { data: "A", isPlaceholderData: true },
    { data: undefined, isPlaceholderData: false },
  ]);
  // 하나 꼴도 같다 — 앞 값이 하나뿐이다
  const one = renderHook(({ path }) => view(key, { args: at("r1", path), placeholderData: sameRepo }), {
    initialProps: { path: "a" },
  });
  one.rerender({ path: "c" });
  expect(one.result.current).toMatchObject({ data: "A", isPlaceholderData: true });
  one.rerender({ path: "x" });
  expect(one.result.current.isPlaceholderData).toBe(true);
});
it("prev 는 보이던 값이다 — A→B→C 로 빠르게 바꾸면 C 는 A 값을 잇는다", async () => {
  const q = controlled<string>();
  const key = define(() => createResource(() => ({ query: (a: string) => q.fn(a) })));
  const seen: Prev<string, string>[][] = [];
  const keep = (a: string, prev: Prev<string, string>[]) => (seen.push(prev), keepPreviousData(a, prev));
  const { result, rerender } = renderHook(({ args }) => view(key, { args, placeholderData: keep }), {
    initialProps: { args: "A" },
  });
  await act(async () => q.calls[0]!.resolve("a"));
  rerender({ args: "B" });
  rerender({ args: "C" });
  expect(seen.at(-1)).toEqual([{ args: "B", data: "a" }]);
  expect(result.current).toMatchObject({ data: "a", isPlaceholderData: true });
  // B 가 늦게 와도 C 에는 보인 적 없는 B 값이 오지 않는다
  await act(async () => q.calls[1]!.resolve("b"));
  expect(result.current).toMatchObject({ data: "a", isPlaceholderData: true });
  await act(async () => q.calls[2]!.resolve("c"));
  expect(result.current).toMatchObject({ data: "c", isPlaceholderData: false });
});
it("자리를 채운 값에도 자원·화면 select 가 걸린다", () => {
  const key = define(() =>
    createResource(() => ({ query: (a: { id: number }) => new Promise<number>(() => void a) }), {
      select: (d: number) => `r:${d}`,
    }),
  );
  const { result } = renderHook(() =>
    view(key, { args: ids(1), pick: ["data"], placeholderData: 7, select: (s: string, a: { id: number }) => `${s}@${a.id}` }),
  );
  expect(result.current).toEqual([{ data: "r:7@1" }]);
});
it("prev 는 select 전 값이고 data 를 고르지 않아도, 고른 칸이 바뀌어도 남는다", async () => {
  const { q, key } = byId();
  const seen: Prev<{ id: number }, number>[][] = [];
  const keep = (a: { id: number }, prev: Prev<{ id: number }, number>[]) => (seen.push(prev), keepPreviousData(a, prev));
  const { result, rerender } = renderHook(
    ({ id, pick }) => view(key, { args: { id }, pick, placeholderData: keep, select: (d: number) => `s${d}` }),
    { initialProps: { id: 1, pick: ["data"] } },
  );
  await act(async () => q.calls[0]!.resolve(10));
  rerender({ id: 2, pick: ["isPlaceholderData"] });
  expect(result.current).toEqual({ isPlaceholderData: true });
  expect(seen.at(-1)).toEqual([{ args: { id: 1 }, data: 10 }]);
  rerender({ id: 3, pick: ["data", "isPlaceholderData"] });
  expect(result.current).toEqual({ data: "s10", isPlaceholderData: true });
  expect(seen.at(-1)).toEqual([{ args: { id: 2 }, data: 10 }]);
});
it("자리 채우기: 부를 때마다 새 객체를 짓는 함수여도 끝없이 다시 그리지 않는다", async () => {
  const { key } = byId();
  const { result, renders } = counted(key, () => ({ args: { id: 1 }, placeholderData: () => ({ list: [] }) }));
  await flush();
  expect(result.current).toMatchObject({ data: { list: [] }, isPlaceholderData: true });
  const before = renders();
  act(() => state(key).setData(5, { id: 9 }));
  expect(renders()).toBe(before);
});
