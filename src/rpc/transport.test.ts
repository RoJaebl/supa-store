// @vitest-environment node
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type ServerOptions, type WebSocket } from "ws";
import { TIMING } from "../stream/client.js";
import { encode } from "./framing.js";
import { stdio, websocket, type Transport } from "./transport.js";

const fake = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
const killable = () => Object.assign(fake(), { kill: vi.fn() });

const closes = (t: Transport) => {
  const got: (Error | undefined)[] = [];
  t.onClose((r) => got.push(r));
  return got;
};

const tick = () => new Promise((r) => setImmediate(r));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

describe("stdio", () => {
  it("보낸 글자가 틀대로 써지고 써 넣은 메시지가 온다", async () => {
    const child = fake();
    const t = stdio(child, { framing: "content-length" });
    const written: Buffer[] = [];
    child.stdin.on("data", (b: Buffer) => written.push(b));
    const got: string[] = [];
    t.onMessage((m) => got.push(m));
    t.send('{"a":1}');
    child.stdout.write(Buffer.concat([encode("content-length", "{}"), encode("content-length", '{"b":2}')]));
    await tick();
    expect(Buffer.concat(written)).toEqual(encode("content-length", '{"a":1}'));
    expect(got).toEqual(["{}", '{"b":2}']);
  });

  it("받는 쪽이 던져도 다음 메시지를 받는다", async () => {
    const child = fake();
    const t = stdio(child, { framing: "ndjson" });
    const got: string[] = [];
    t.onMessage((m) => {
      got.push(m);
      throw new Error("x");
    });
    child.stdout.write("1\n2\n");
    await tick();
    expect(got).toEqual(["1", "2"]);
  });

  it("출력이 end 되면 onClose 가 한 번 온다 — close 가 뒤따라도", async () => {
    const child = fake();
    const got = closes(stdio(child, { framing: "ndjson" }));
    child.stdout.end();
    child.stdout.resume();
    await tick();
    child.emit("close");
    expect(got).toEqual([undefined]);
  });

  it("close 에도 한 번만 온다", () => {
    const child = fake();
    const got = closes(stdio(child, { framing: "ndjson" }));
    child.emit("close");
    child.emit("close");
    expect(got).toHaveLength(1);
  });

  it("onClose 뒤에는 메시지를 알리지 않는다", async () => {
    const child = fake();
    const t = stdio(child, { framing: "ndjson" });
    const got: string[] = [];
    t.onMessage((m) => got.push(m));
    child.emit("close");
    child.stdout.write("1\n");
    await tick();
    expect(got).toEqual([]);
  });

  it("없는 실행 파일을 넘기면 던지지 않고 ENOENT 로 한 번 닫힌다", async () => {
    const t = stdio(spawn("no-such-binary-supa-store"), { framing: "ndjson" });
    const got = closes(t);
    t.send("1");
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    expect((got[0] as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("프로세스가 답을 쓰고 곧바로 끝나도 답이 onClose 전에 온다", async () => {
    const code = `process.stdout.write(${JSON.stringify('{"a":1}\n')})`;
    const t = stdio(spawn(process.execPath, ["-e", code]), { framing: "ndjson" });
    const seen: string[] = [];
    t.onMessage((m) => seen.push(m));
    t.onClose(() => seen.push("closed"));
    await until(() => seen.includes("closed"));
    expect(seen).toEqual(['{"a":1}', "closed"]);
  });

  describe("close", () => {
    afterEach(() => vi.useRealTimers());

    it("표준 입력을 닫고 killAfter 안에 끝나지 않으면 없으면 kill 을 한 번 부른다", () => {
      vi.useFakeTimers();
      const child = killable();
      const t = stdio(child, { framing: "ndjson", killAfter: 500 });
      const got = closes(t);
      t.close();
      expect(child.stdin.writableEnded).toBe(true);
      vi.advanceTimersByTime(499);
      expect(child.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit("close");
      expect(got).toHaveLength(1);
    });

    it("그 안에 끝나지 않으면 오면 kill 을 부르지 않는다", () => {
      vi.useFakeTimers();
      const child = killable();
      const t = stdio(child, { framing: "ndjson" });
      t.close();
      vi.advanceTimersByTime(1_999);
      child.emit("close");
      vi.advanceTimersByTime(10_000);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("이미 끝났으면 kill 을 걸지 않는다", () => {
      vi.useFakeTimers();
      const child = killable();
      const t = stdio(child, { framing: "ndjson" });
      child.emit("close");
      t.close();
      vi.advanceTimersByTime(10_000);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("close 뒤의 send 는 버리고 reason 은 비운다", async () => {
      const child = killable();
      const t = stdio(child, { framing: "ndjson" });
      const got = closes(t);
      t.close();
      t.send("1");
      await tick();
      child.emit("close");
      expect(got).toEqual([undefined]);
    });
  });
});

describe("websocket", () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      for (const c of s.clients) c.terminate();
      await new Promise((r) => s.close(r));
    }
  });

  const serve = async (o: ServerOptions = {}) => {
    const s = new WebSocketServer({ port: 0, ...o });
    servers.push(s);
    await new Promise((r) => s.once("listening", r));
    return { s, url: `ws://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };

  it("열리기 전에 보낸 것도 가고 서버의 프레임이 메시지로 온다 · headers 가 닿는다", async () => {
    const { s, url } = await serve();
    const seen: { auth?: string; got: string[] } = { got: [] };
    s.on("connection", (c: WebSocket, req) => {
      seen.auth = req.headers.authorization;
      c.on("message", (d) => {
        seen.got.push(String(d));
        c.send(`echo ${String(d)}`);
      });
    });
    const t = websocket(url, { headers: { authorization: "Bearer k" } });
    const got: string[] = [];
    t.onMessage((m) => got.push(m));
    t.send("1");
    t.send("2");
    await until(() => got.length === 2);
    expect(got).toEqual(["echo 1", "echo 2"]);
    expect(seen).toEqual({ auth: "Bearer k", got: ["1", "2"] });
    const c = closes(t);
    t.close();
    await until(() => c.length === 1);
    expect(c).toEqual([undefined]);
  });

  it("maxPayload 를 넘는 메시지가 오면 onClose 가 온다", async () => {
    const { s, url } = await serve();
    s.on("connection", (c: WebSocket) => c.send("x".repeat(100)));
    const t = websocket(url, { maxPayload: 10 });
    const got = closes(t);
    await until(() => got.length === 1);
    expect(got[0]).toBeInstanceOf(Error);
  });

  it("pong 이 없으면 끊김 판정 시간 뒤에 onClose 가 온다", async () => {
    const { url } = await serve({ autoPong: false });
    const t = websocket(url, { [TIMING]: { pingMs: 20, idleMs: 60 } } as Parameters<typeof websocket>[1]);
    const got = closes(t);
    await until(() => got.length === 1);
    expect(got[0]).toBeInstanceOf(Error);
  });

  it("pong 이 오면 끊지 않는다", async () => {
    const { url } = await serve();
    const t = websocket(url, { [TIMING]: { pingMs: 20, idleMs: 60 } } as Parameters<typeof websocket>[1]);
    const got = closes(t);
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([]);
    t.close();
  });
});
