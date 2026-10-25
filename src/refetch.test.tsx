import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore, overrideStore, resetStores } from "./index.js";
import { createResource } from "./query.js";
import { useStore } from "./react.js";

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  resetStores();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let n = 0;
function define(creator: () => object): string {
  const key = `api.refetch.r${++n}`;
  createStore(key, creator);
  return key;
}
const view = (key: string, options?: object): any => (useStore as any)(key, options);
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const flush = () => tick(0);
const setHidden = (value: boolean) =>
  act(async () => {
    hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  });

/** 곧바로 끝나는 조회 — 불린 시각을 남긴다 */
function counted(options: object = {}) {
  const at: number[] = [];
  const key = define(() => createResource(() => ({ query: async () => (at.push(Date.now()), at.length) }), options));
  return { key, at };
}

it("주기: 자원 간격이 숫자면 화면 값을 보지 않는다", async () => {
  const { key, at } = counted({ refetchInterval: 60_000 });
  renderHook(() => view(key, { refetchInterval: 5_000 }));
  await flush();
  expect(at).toHaveLength(1);
  await tick(5_000);
  expect(at).toHaveLength(1);
  await tick(55_000);
  expect(at).toHaveLength(2);
});

it("주기: 자원이 false·undefined 면 보는 화면 가운데 가장 짧은 간격", async () => {
  const { key, at } = counted({ refetchInterval: () => false });
  renderHook(() => view(key, { refetchInterval: 5_000 }));
  const short = renderHook(() => view(key, { refetchInterval: () => 3_000 }));
  renderHook(() => view(key, { refetchInterval: false }));
  await flush();
  await tick(3_000);
  expect(at).toEqual([0, 3_000]);
  // 짧은 화면이 떠나면 남은 화면의 간격으로 — 앞 받기가 끝난 때부터 센다
  short.unmount();
  await tick(4_999);
  expect(at).toHaveLength(2);
  await tick(1);
  expect(at).toEqual([0, 3_000, 8_000]);
});

it("주기: 같은 args 를 화면 셋이 봐도 타이머는 하나", async () => {
  const { key, at } = counted();
  for (let i = 0; i < 3; i++) renderHook(() => view(key, { refetchInterval: 1_000 }));
  await flush();
  expect(vi.getTimerCount()).toBe(1);
  await tick(3_000);
  expect(at).toEqual([0, 1_000, 2_000, 3_000]);
});

it("주기: 간격은 받기가 끝난 때부터 센다", async () => {
  const at: number[] = [];
  const key = define(() =>
    createResource(() => ({ query: () => (at.push(Date.now()), new Promise<number>((r) => setTimeout(() => r(1), 3_000))) }), {
      refetchInterval: 10_000,
    }),
  );
  renderHook(() => view(key));
  await tick(12_999);
  expect(at).toEqual([0]);
  await tick(1);
  expect(at).toEqual([0, 13_000]);
});

it("주기: 마지막 화면이 떠나면 멈추고, 받는 중에 떠나면 끝나도 다시 걸지 않는다", async () => {
  const { key, at } = counted({ refetchInterval: 1_000 });
  const a = renderHook(() => view(key));
  await flush();
  a.unmount();
  await tick(5_000);
  expect(at).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);

  const resolves: Array<() => void> = [];
  const slow = define(() =>
    createResource(() => ({ query: () => new Promise<void>((r) => resolves.push(r)) }), { refetchInterval: 1_000 }),
  );
  const b = renderHook(() => view(slow));
  await act(async () => resolves[0]!());
  await tick(1_000);
  expect(resolves).toHaveLength(2);
  b.unmount();
  await act(async () => resolves[1]!());
  await tick(5_000);
  expect(resolves).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("주기: 창이 가려지면 멈추고, 보일 때 간격이 지났으면 곧바로 받는다", async () => {
  const { key, at } = counted({ refetchInterval: 1_000 });
  renderHook(() => view(key));
  await flush();
  await setHidden(true);
  await tick(5_000);
  expect(at).toEqual([0]);
  await setHidden(false);
  expect(at).toEqual([0, 5_000]);
  // 아직 간격이 지나지 않았으면 보여도 곧바로 받지 않는다
  await tick(200);
  await setHidden(true);
  await tick(300);
  await setHidden(false);
  expect(at).toHaveLength(2);
  await tick(500);
  expect(at).toEqual([0, 5_000, 6_000]);
});

it("주기: 실패하면 두 배씩 8배까지 늘고, refetch 가 한 번 성공하면 되돌아간다", async () => {
  let fail = false;
  const at: number[] = [];
  const key = define(() =>
    createResource(
      () => ({
        query: async () => {
          at.push(Date.now());
          if (fail) throw new Error("x");
          return 1;
        },
      }),
      { refetchInterval: 1_000 },
    ),
  );
  const { result } = renderHook(() => view(key));
  await flush();
  fail = true;
  await tick(23_000);
  expect(at).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
  fail = false;
  await tick(500);
  await act(() => result.current.refetch());
  await tick(1_000);
  expect(at).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000, 23_500, 24_500]);
});

it("주기: 기본 간격이 바뀌어도 늘린 정도는 그대로 새 간격에 곱한다", async () => {
  const at: number[] = [];
  // auto: false — 화면이 새로 열려도 실패한 칸을 곧바로 다시 받지 않게 한다
  const key = define(() =>
    createResource(
      () => ({
        query: async () => {
          at.push(Date.now());
          throw new Error("x");
        },
      }),
      { auto: false },
    ),
  );
  renderHook(() => view(key, { refetchInterval: 1_000 }));
  await tick(1_500); // 1_000 에 실패 — 다음은 2배
  renderHook(() => view(key, { refetchInterval: 500 }));
  // 새 기본 500 × 2 = 1_000, 앞 받기가 끝난 1_000 부터
  await tick(499);
  expect(at).toEqual([1_000]);
  await tick(1);
  expect(at).toEqual([1_000, 2_000]);
  // 또 실패 — 500 × 4
  await tick(2_000);
  expect(at).toEqual([1_000, 2_000, 4_000]);
});

it("주기: auto: false 로 받은 적 없는 args 는 간격 뒤 첫 주기에서 처음 받는다", async () => {
  const { key, at } = counted({ auto: false, refetchInterval: 2_000 });
  const { result } = renderHook(() => view(key));
  await tick(1_999);
  expect(at).toHaveLength(0);
  await tick(1);
  expect(at).toEqual([2_000]);
  expect(result.current).toMatchObject({ data: 1, status: "ready" });
});

it("주기: 자원을 다시 지으면 앞 타이머가 멈추고 새 자원에 다시 걸린다", async () => {
  const old = counted({ refetchInterval: 1_000 });
  renderHook(() => view(old.key));
  await tick(1_000);
  expect(old.at).toHaveLength(2);
  const at: number[] = [];
  await act(async () =>
    overrideStore(old.key as never, () =>
      createResource(() => ({ query: async () => void at.push(Date.now()) }), { refetchInterval: 1_000 }),
    ),
  );
  await tick(3_000);
  expect(old.at).toHaveLength(2);
  expect(at).toEqual([1_000, 2_000, 3_000, 4_000]);
  expect(vi.getTimerCount()).toBe(1);
});

it("주기: 목록 꼴은 args 마다 따로 간격을 정한다", async () => {
  const at: Record<string, number[]> = { ssh: [], local: [], wsl: [] };
  const key = define(() =>
    createResource(() => ({ query: async (a: { source: string }) => void at[a.source]!.push(Date.now()) })),
  );
  const interval = ({ source }: { source: string }) => (source === "ssh" ? 10_000 : false);
  const { rerender } = renderHook((args: object[]) => view(key, { args, refetchInterval: interval }), {
    initialProps: [{ source: "ssh" }, { source: "local" }, { source: "ssh" }],
  });
  await tick(5_000);
  // 목록이 늘어도 그대로인 args 의 타이머는 다시 걸리지 않는다
  rerender([{ source: "ssh" }, { source: "local" }, { source: "wsl" }]);
  await tick(5_000);
  expect(at).toEqual({ ssh: [0, 10_000], local: [0], wsl: [5_000] });
});

it("주기: 서버에서 그릴 때는 타이머를 걸지 않는다", () => {
  const { key, at } = counted({ refetchInterval: 1_000 });
  const P = () => <>{String(view(key, { refetchInterval: 1_000 }).status)}</>;
  expect(renderToString(<P />)).toBe("idle");
  expect(vi.getTimerCount()).toBe(0);
  expect(at).toHaveLength(0);
});

it("주기: args 는 그대로이고 화면 간격만 false → 숫자로 바뀌어도 타이머를 건다", async () => {
  const { key, at } = counted();
  const { rerender } = renderHook(({ ms }) => view(key, { refetchInterval: ms }), {
    initialProps: { ms: false as number | false },
  });
  await flush();
  expect(at).toEqual([0]);
  await tick(2_000);
  rerender({ ms: 1_000 });
  // 받기가 끝난 때부터 센다 — 이미 지났으므로 곧바로
  await flush();
  expect(at).toEqual([0, 2_000]);
  await tick(1_000);
  expect(at).toEqual([0, 2_000, 3_000]);
});

it("주기: 화면 간격이 숫자 → false 로 바뀌면 걸린 타이머를 걷고 더 받지 않는다", async () => {
  const { key, at } = counted();
  const { rerender } = renderHook(({ ms }) => view(key, { refetchInterval: ms }), {
    initialProps: { ms: 1_000 as number | false },
  });
  await flush();
  await tick(500);
  rerender({ ms: false });
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  await tick(5_000);
  expect(at).toEqual([0]);
});

it("주기: 간격 함수가 던지면 그 args 는 간격이 없는 것으로 보고 받은 값은 그대로 준다", async () => {
  const { key, at } = counted({
    refetchInterval: () => {
      throw new Error("간격");
    },
  });
  const { result } = renderHook(() => view(key));
  await flush();
  expect(result.current).toMatchObject({ data: 1, status: "ready" });
  await tick(5_000);
  expect(at).toEqual([0]);
});
