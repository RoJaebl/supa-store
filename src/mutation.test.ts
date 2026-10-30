import { expect, it, vi } from "vitest";
import { createMutation, resetScopes } from "./mutation.js";

/** 부를 때마다 새 약속을 내주고, 시험이 차례대로 풀게 한다 */
function controlled<T>() {
  const calls: Array<{ args: unknown[]; resolve: (value: T) => void; reject: (e: Error) => void }> = [];
  const fn = vi.fn(
    (...args: any[]) => new Promise<T>((resolve, reject) => calls.push({ args, resolve, reject })),
  ) as (...args: any[]) => Promise<T>;
  return { fn, calls };
}

it("부르면 inflight 에 인자가 서고, 끝나면 빠진다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const p = m.call(1, "a");
  expect(m.call.inflight).toEqual([[1, "a"]]);
  expect(m.call.pending).toBe(true);
  calls[0]!.resolve(10);
  await p;
  expect(m.call.inflight).toEqual([]);
  expect(m.call.data).toBe(10);
  expect(m.call.pending).toBe(false);
});

it("같은 인자로 두 번 부르면 둘이 서고 끝난 하나만 빠진다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const p1 = m.call(1);
  const p2 = m.call(1);
  expect(m.call.inflight).toEqual([[1], [1]]);
  calls[1]!.resolve(2);
  await p2;
  expect(m.call.inflight).toEqual([[1]]);
  calls[0]!.resolve(1);
  await p1;
  expect(m.call.inflight).toEqual([]);
});

it("onSuccess 가 inflight 에서 빼기 전에 돈다", async () => {
  const { fn, calls } = controlled<number>();
  let seen = -1;
  const m = createMutation(fn, { onSuccess: () => void (seen = m.call.inflight.length) });
  const p = m.call(1);
  calls[0]!.resolve(1);
  await p;
  expect(seen).toBe(1);
});

it("실패하면 error 를 적고 onError · onSettled 를 부른 뒤 빠진다", async () => {
  const { fn, calls } = controlled<number>();
  const onError = vi.fn();
  const onSettled = vi.fn();
  let seen = -1;
  const m = createMutation(fn, { onError, onSettled: (...a) => ((seen = m.call.inflight.length), onSettled(...a)) });
  const p = m.call(7);
  const boom = new Error("boom");
  calls[0]!.reject(boom);
  await expect(p).rejects.toBe(boom);
  expect(m.call.error).toBe("boom");
  expect(onError).toHaveBeenCalledWith(boom, 7);
  expect(onSettled).toHaveBeenCalledWith(undefined, boom, 7);
  expect(seen).toBe(1);
  expect(m.call.inflight).toEqual([]);
});

it("호출을 시작하면 앞 실패의 error 를 지운다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const p1 = m.call(1);
  calls[0]!.reject(new Error("boom"));
  await expect(p1).rejects.toThrow("boom");
  expect(m.call.error).toBe("boom");
  const p2 = m.call(2);
  expect(m.call.error).toBeNull();
  calls[1]!.resolve(2);
  await p2;
});

it("늦은 응답은 data · error · 콜백을 건드리지 않고 자기 결과로 끝난다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const onSettled = vi.fn();
  const m = createMutation(fn, { onSuccess, onSettled });
  const p1 = m.call(1);
  const p2 = m.call(2);
  calls[1]!.resolve(10);
  await p2;
  calls[0]!.resolve(5);
  await expect(p1).resolves.toBe(5);
  expect(m.call.data).toBe(10);
  expect(onSuccess).toHaveBeenCalledTimes(1);
  expect(onSuccess).toHaveBeenCalledWith(10, 2);
  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(m.call.inflight).toEqual([]);
});

it("늦은 실패도 error 를 적지 않는다", async () => {
  const { fn, calls } = controlled<number>();
  const onError = vi.fn();
  const m = createMutation(fn, { onError });
  const p1 = m.call(1);
  const p2 = m.call(2);
  calls[1]!.resolve(10);
  await p2;
  calls[0]!.reject(new Error("late"));
  await expect(p1).rejects.toThrow("late");
  expect(m.call.error).toBeNull();
  expect(onError).not.toHaveBeenCalled();
});

it("reset 은 error · data 를 지우고 앞서 떠난 호출의 결과를 받지 않는다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const m = createMutation(fn, { onSuccess });
  const first = m.call(1);
  calls[0]!.resolve(1);
  await first;
  const p = m.call(2);
  m.call.reset();
  expect(m.call.data).toBeUndefined();
  expect(m.call.error).toBeNull();
  // reset 은 inflight 를 지우지 않는다 — 그 호출이 끝날 때 빠진다
  expect(m.call.inflight).toEqual([[2]]);
  calls[1]!.resolve(2);
  await expect(p).resolves.toBe(2);
  expect(m.call.data).toBeUndefined();
  // reset 은 칸만 막는다 — 앞서 떠난 호출의 콜백은 돈다
  expect(onSuccess).toHaveBeenCalledTimes(2);
  expect(m.call.inflight).toEqual([]);
});

it("콜백이 던져도 inflight 에서 빠지고 호출의 결과는 그대로다", async () => {
  const { fn, calls } = controlled<number>();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const oops = new Error("oops");
  const m = createMutation(fn, {
    onSuccess: () => {
      throw oops;
    },
  });
  const p = m.call(1);
  calls[0]!.resolve(3);
  await expect(p).resolves.toBe(3);
  expect(m.call.inflight).toEqual([]);
  expect(m.call.data).toBe(3);
  expect(logged).toHaveBeenCalledWith(oops);
  logged.mockRestore();
});

it("상태가 바뀔 때마다 구독자에게 알리고 snapshot 이 새 객체다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const seen: unknown[] = [];
  const stop = m.channel.subscribe(() => seen.push(m.channel.snapshot()));
  const before = m.channel.snapshot();
  const p = m.call(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toBe(before);
  expect(seen[0]).toEqual({ inflight: [[1]], pending: true, error: null, data: undefined });
  calls[0]!.resolve(4);
  await p;
  expect(seen.at(-1)).toEqual({ inflight: [], pending: false, error: null, data: 4 });
  expect(new Set(seen).size).toBe(seen.length);
  const count = seen.length;
  m.call.reset();
  expect(seen).toHaveLength(count + 1);
  stop();
  m.call.reset();
  expect(seen).toHaveLength(count + 1);
});

it("같은 scope.id 의 바꾸기는 다른 자원이어도 차례대로 나간다", async () => {
  const a = controlled<number>();
  const b = controlled<number>();
  const ma = createMutation(a.fn, { scope: { id: "s" } });
  const mb = createMutation(b.fn, { scope: { id: "s" } });
  const pa = ma.call(1);
  const pb = mb.call(2);
  await Promise.resolve();
  expect(a.calls).toHaveLength(1);
  expect(b.calls).toHaveLength(0);
  a.calls[0]!.resolve(1);
  await pa;
  await Promise.resolve();
  expect(b.calls).toHaveLength(1);
  b.calls[0]!.resolve(2);
  await pb;
});

it("줄에서 기다리는 호출의 인자도 inflight 에 있다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn, { scope: { id: "w" } });
  const p1 = m.call(1);
  const p2 = m.call(2);
  expect(m.call.inflight).toEqual([[1], [2]]);
  expect(calls).toHaveLength(1);
  calls[0]!.resolve(1);
  await p1;
  expect(m.call.inflight).toEqual([[2]]);
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(2);
  await p2;
});

it("앞 호출이 실패해도 다음 호출이 나간다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn, { scope: { id: "f" } });
  const p1 = m.call(1);
  const p2 = m.call(2);
  expect(calls).toHaveLength(1);
  calls[0]!.reject(new Error("x"));
  await expect(p1).rejects.toThrow("x");
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(2);
  await expect(p2).resolves.toBe(2);
});

it("scope 가 없으면 동시에 나간다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const p1 = m.call(1);
  const p2 = m.call(2);
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  calls[0]!.resolve(1);
  calls[1]!.resolve(2);
  await Promise.all([p1, p2]);
});

it("reset 한 뒤에도 앞서 떠난 호출의 onSuccess 는 불린다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const onSettled = vi.fn();
  const m = createMutation(fn, { onSuccess, onSettled });
  const p = m.call(1);
  m.call.reset();
  calls[0]!.resolve(1);
  await p;
  expect(onSuccess).toHaveBeenCalledWith(1, 1);
  expect(onSettled).toHaveBeenCalledWith(1, null, 1);
  expect(m.call.data).toBeUndefined();
});

it("reset 한 뒤에도 앞서 떠난 호출의 onError 는 불리고 error 는 적지 않는다", async () => {
  const { fn, calls } = controlled<number>();
  const onError = vi.fn();
  const m = createMutation(fn, { onError });
  const p = m.call(1);
  m.call.reset();
  calls[0]!.reject(new Error("x"));
  await expect(p).rejects.toThrow("x");
  expect(onError).toHaveBeenCalledTimes(1);
  expect(m.call.error).toBeNull();
});

it("reset 한 뒤에도 scope 줄에서 기다리던 호출의 onSuccess 는 불린다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const m = createMutation(fn, { onSuccess, scope: { id: "reset-wait" } });
  const p1 = m.call(1);
  const p2 = m.call(2);
  m.call.reset();
  calls[0]!.resolve(1);
  await p1;
  await Promise.resolve();
  calls[1]!.resolve(2);
  await p2;
  expect(onSuccess.mock.calls).toEqual([
    [1, 1],
    [2, 2],
  ]);
  expect(m.call.data).toBeUndefined();
});

it("reset 뒤에 보낸 호출은 data 를 적는다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const p1 = m.call(1);
  m.call.reset();
  const p2 = m.call(2);
  calls[1]!.resolve(2);
  await p2;
  expect(m.call.data).toBe(2);
  calls[0]!.resolve(1);
  await p1;
  expect(m.call.data).toBe(2);
});

it("resetScopes 는 줄을 비운다 — 뒤 호출이 옛 호출을 기다리지 않는다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn, { scope: { id: "reset-scopes" } });
  void m.call(1);
  resetScopes();
  const p = m.call(2);
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(2);
  await expect(p).resolves.toBe(2);
});
