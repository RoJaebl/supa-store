// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEXT } from "../stream/protocol.js";
import { RpcError } from "./error.js";
import { openSession } from "./session.js";
import type { Transport } from "./transport.js";

/** 보낸 것을 sent 에 담고, 받기 · 닫힘은 손으로 넣는다 */
const fake = () => {
  const sent: unknown[] = [];
  let message = (_: string) => {};
  let close = (_?: Error) => {};
  let closed = false;
  const t: Transport = {
    send: (m) => void (closed || sent.push(JSON.parse(m))),
    onMessage: (fn) => void (message = fn),
    onClose: (fn) => void (close = fn),
    close: vi.fn(() => {
      if (closed) return;
      closed = true;
      close();
    }),
  };
  return {
    t,
    sent,
    receive: (m: unknown) => message(typeof m === "string" ? m : JSON.stringify(m)),
    end: (r?: Error) => {
      closed = true;
      close(r);
    },
  };
};

const open = (handlers?: Record<string, (params: any) => unknown>) => {
  const f = fake();
  const notes: unknown[] = [];
  const onClose = vi.fn();
  const s = openSession(f.t, {
    handlers,
    onNotification: (n) => notes.push(n),
    onClose,
  });
  return { ...f, s, notes, onClose };
};

const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => void vi.useRealTimers());

describe("요청", () => {
  it("id 1 로 나가고 같은 id 의 result 로 풀린다", async () => {
    const { s, sent, receive } = open();
    const p = s.request("m", { a: 1 }, 1_000);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "m", params: { a: 1 } }]);
    void s.request("n", null, 1_000);
    expect((sent[1] as { id: number }).id).toBe(2);
    receive({ jsonrpc: "2.0", id: 1, result: "ok" });
    await expect(p).resolves.toBe("ok");
  });

  it("error 답은 상대의 문구 · code · data · requestId 를 가진 RpcError 다", async () => {
    const { s, receive } = open();
    const p = s.request("m", {}, 1_000);
    receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "안 됨", data: { x: 1 } },
    });
    const e = await p.catch((e) => e);
    expect(e).toBeInstanceOf(RpcError);
    expect(e).toMatchObject({
      message: "안 됨",
      code: -32000,
      data: { x: 1 },
      requestId: 1,
    });
  });

  it("제한 시간이 지나면 응답 지연이고 cancel 알림이 나간다. 늦은 답 · 모르는 id 는 버린다", async () => {
    vi.useFakeTimers();
    const { s, sent, receive } = open();
    const p = s.request("m", {}, 100, (id) => ({
      method: "$/cancelRequest",
      params: { id },
    }));
    vi.advanceTimersByTime(100);
    await expect(p).rejects.toMatchObject({
      message: TEXT.timeout,
      requestId: 1,
    });
    expect(sent[1]).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 1 },
    });
    expect(() => receive({ jsonrpc: "2.0", id: 1, result: 1 })).not.toThrow();
    expect(() => receive({ jsonrpc: "2.0", id: 99, result: 1 })).not.toThrow();
    expect(sent).toHaveLength(2);
  });

  it("cancel 이 없으면 아무것도 더 나가지 않는다", async () => {
    vi.useFakeTimers();
    const { s, sent } = open();
    const p = s.request("m", {}, 100);
    vi.advanceTimersByTime(100);
    await expect(p).rejects.toMatchObject({ message: TEXT.timeout });
    expect(sent).toHaveLength(1);
  });

  it("send 도중 이미 답이 온 요청에는 타이머를 걸지 않는다", async () => {
    vi.useFakeTimers();
    let message = (_: string) => {};
    const t: Transport = {
      send: (m) => message(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(m).id, result: "곧바로" })),
      onMessage: (fn) => void (message = fn),
      onClose: () => {},
      close: () => {},
    };
    const s = openSession(t, { onNotification: () => {}, onClose: () => {} });
    await expect(s.request("m", {}, 1_000)).resolves.toBe("곧바로");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("닫힘", () => {
  it("통로가 닫히면 기다리던 요청은 알 수 없음이고 onClose 를 한 번 부른다", async () => {
    const { s, end, onClose } = open();
    const p = s.request("m", {}, 1_000);
    end(new Error("끊김"));
    await expect(p).rejects.toMatchObject({
      message: TEXT.unknown,
      requestId: 1,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close() 면 명령 실패이고, 뒤따른 통로의 닫힘이 그것을 바꾸지 않는다", async () => {
    const { s, t, onClose } = open();
    const p = s.request("m", {}, 1_000);
    s.close();
    await expect(p).rejects.toMatchObject({ message: TEXT.commandFailed });
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("닫힌 뒤의 요청은 곧바로 거절된다", async () => {
    const { s } = open();
    s.close();
    await expect(s.request("m", {}, 1_000)).rejects.toMatchObject({
      message: TEXT.commandFailed,
    });
  });
});

describe("상대의 요청", () => {
  it("handler 의 값(Promise 도)으로 답하고 undefined 면 null 이다. params 는 하나로 받는다", async () => {
    const got: unknown[] = [];
    const { sent, receive } = open({
      a: (p) => (got.push(p), 1),
      b: async () => "b",
      c: () => undefined,
    });
    receive({ jsonrpc: "2.0", id: 1, method: "a", params: [1, 2] });
    receive({ jsonrpc: "2.0", id: "x", method: "b" });
    receive({ jsonrpc: "2.0", id: 3, method: "c" });
    await tick();
    expect(got).toEqual([[1, 2]]);
    expect(sent).toHaveLength(3); // 답의 차례는 handler 가 끝나는 차례다
    expect(sent).toEqual(
      expect.arrayContaining([
        { jsonrpc: "2.0", id: 1, result: 1 },
        { jsonrpc: "2.0", id: "x", result: "b" },
        { jsonrpc: "2.0", id: 3, result: null },
      ]),
    );
  });

  it("던지면 -32603, 없으면 -32601 이고 통로를 닫지 않는다", async () => {
    const { t, sent, receive } = open({
      bad: () => {
        throw new Error("터짐");
      },
      worse: () => Promise.reject(new Error("늦게 터짐")),
    });
    receive({ jsonrpc: "2.0", id: 1, method: "bad" });
    receive({ jsonrpc: "2.0", id: 2, method: "worse" });
    receive({ jsonrpc: "2.0", id: 3, method: "none" });
    receive({ jsonrpc: "2.0", id: 4, method: "toString" });
    await tick();
    expect(sent).toHaveLength(4);
    expect(sent).toEqual(
      expect.arrayContaining([
        { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "터짐" } },
        {
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32603, message: "늦게 터짐" },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          error: { code: -32601, message: "Method not found" },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          error: { code: -32601, message: "Method not found" },
        },
      ]),
    );
    expect(t.close).not.toHaveBeenCalled();
  });
});

describe("받기", () => {
  it("알림은 onNotification 으로 가고 배열은 하나씩 푼다", async () => {
    const { s, notes, receive } = open();
    const p = s.request("m", {}, 1_000);
    receive([
      { jsonrpc: "2.0", method: "n", params: { a: 1 } },
      { jsonrpc: "2.0", id: 1, result: 2 },
      { jsonrpc: "2.0", method: "o" },
    ]);
    await expect(p).resolves.toBe(2);
    expect(notes).toEqual([{ method: "n", params: { a: 1 } }, { method: "o" }]);
  });

  it("JSON 이 아닌 글자 · 잘못된 꼴은 버리고 던지거나 닫지 않는다", () => {
    const { t, sent, notes, receive } = open({ m: () => 1 });
    for (const m of ["{not json", "null", "1", '"s"', { id: {}, method: "m" }, { id: {}, result: 1 }, { method: 1 }, [null, 2]]) {
      expect(() => receive(m)).not.toThrow();
    }
    expect(sent).toEqual([]);
    expect(notes).toEqual([]);
    expect(t.close).not.toHaveBeenCalled();
  });

  it("onNotification 이 던져도 다음 메시지를 읽는다", async () => {
    const f = fake();
    const s = openSession(f.t, {
      onNotification: () => {
        throw new Error("x");
      },
      onClose: () => {},
    });
    const p = s.request("m", {}, 1_000);
    expect(() =>
      f.receive([
        { jsonrpc: "2.0", method: "n" },
        { jsonrpc: "2.0", id: 1, result: 1 },
      ]),
    ).not.toThrow();
    await expect(p).resolves.toBe(1);
  });
});

describe("notify", () => {
  it("id 없이 나가고 params 를 주지 않으면 그 칸이 없다", () => {
    const { s, sent } = open();
    s.notify("a", { x: 1 });
    s.notify("b");
    expect(sent).toEqual([
      { jsonrpc: "2.0", method: "a", params: { x: 1 } },
      { jsonrpc: "2.0", method: "b" },
    ]);
    expect(Object.keys(sent[1] as object)).not.toContain("params");
  });
});

describe("고침 1 — 직렬화 · 답의 꼴 · 타이머", () => {
  it("handler 가 글자로 바뀌지 않는 값을 돌려주면 -32603 으로 답하고 처리되지 않은 거절이 없다", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { sent, receive } = open({ big: () => 1n });
      receive({ jsonrpc: "2.0", id: 1, method: "big" });
      await tick();
      await tick();
      expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: expect.any(String) } }]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("result 도 error 도 없는 답, error 가 객체가 아닌 답, id 가 null · 글자인 답은 버린다", async () => {
    const { s, receive } = open();
    const p = s.request("m", {}, 1_000);
    receive({ jsonrpc: "2.0", id: 1 });
    receive({ jsonrpc: "2.0", id: 1, error: "x" });
    receive({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    receive({ jsonrpc: "2.0", id: "1", result: "글자" });
    receive({ jsonrpc: "2.0", id: 1, result: "ok" });
    await expect(p).resolves.toBe("ok");
  });

  it("상대 error 의 message 가 글자가 아니면 고정 문구다", async () => {
    const { s, receive } = open();
    const a = s.request("m", {}, 1_000);
    const b = s.request("m", {}, 1_000);
    receive({ jsonrpc: "2.0", id: 1, error: { code: -32000 } });
    receive({ jsonrpc: "2.0", id: 2, error: { message: 3 } });
    await expect(a).rejects.toMatchObject({ message: "상대 오류 -32000", code: -32000 });
    await expect(b).rejects.toMatchObject({ message: "상대 오류", code: undefined });
  });

  it("답이 오면 타이머가 걷히고, 답 뒤의 닫힘은 그 요청을 건드리지 않는다", async () => {
    vi.useFakeTimers();
    const { s, receive, end } = open();
    const p = s.request("m", {}, 1_000);
    expect(vi.getTimerCount()).toBe(1);
    receive({ jsonrpc: "2.0", id: 1, result: 1 });
    expect(vi.getTimerCount()).toBe(0);
    end();
    await expect(p).resolves.toBe(1);
  });

  it("NaN · Infinity · 2^31 이상의 제한 시간에는 타이머를 걸지 않는다", () => {
    vi.useFakeTimers();
    const { s } = open();
    for (const t of [NaN, Infinity, 2 ** 31]) void s.request("m", {}, t);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel 이 던져도 삼키고 응답 지연으로 끝난다", async () => {
    vi.useFakeTimers();
    const { s } = open();
    const p = s.request("m", {}, 10, () => {
      throw new Error("x");
    });
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    await expect(p).rejects.toMatchObject({ message: TEXT.timeout });
  });

  it("params 가 글자로 바뀌지 않으면 그 오류로 거절하고 기다림 · 타이머를 남기지 않는다", async () => {
    vi.useFakeTimers();
    const { s, sent, end } = open();
    await expect(s.request("m", 1n, 1_000)).rejects.toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const q = s.request("n", {}, 1_000);
    end();
    await expect(q).rejects.toMatchObject({ requestId: 2 });
  });
});
