// 통로를 여는 도우미(스펙 §6.2) — 표준 입출력을 가진 프로세스와 웹소켓. 서버 전용이라 node · ws 를 바로 들인다
import type { Readable, Writable } from "node:stream";
import { WebSocket } from "ws";
import { DEFAULTS } from "../stream/protocol.js";
import { TIMING } from "../stream/client.js";
import { createReader, encode, type Framing } from "./framing.js";

export interface Transport {
  send(message: string): void;
  onMessage(fn: (message: string) => void): void;
  /** 한 번만 알린다 — close() 로 닫아도 */
  onClose(fn: (reason?: Error) => void): void;
  close(): void;
}

/** 듣는 이를 모아 알린다 — 쓰는 쪽이 던져도 읽기를 끊지 않는다 */
function base(send: (m: string) => void, close: () => void) {
  const onMessage = new Set<(m: string) => void>();
  const onClose = new Set<(r?: Error) => void>();
  let ended = false;
  const transport: Transport = {
    send: (m) => {
      if (!ended) send(m);
    },
    onMessage: (fn) => void onMessage.add(fn),
    onClose: (fn) => void onClose.add(fn),
    close,
  };
  const message = (m: string) => {
    for (const fn of onMessage) {
      try {
        fn(m);
      } catch {}
    }
  };
  const end = (reason?: Error) => {
    if (ended) return;
    ended = true;
    for (const fn of onClose) {
      try {
        fn(reason);
      } catch {}
    }
  };
  return { transport, message, end };
}

export interface StdioChild {
  stdin: Writable;
  stdout: Readable;
  kill?(): unknown;
  on?(event: "exit", fn: () => void): unknown;
}

/** close() 는 표준 입력을 닫고, kill 이 있으면 killAfter 안에 exit 이 없을 때 kill 한다 */
export function stdio(child: StdioChild, options: { framing: Framing; killAfter?: number }): Transport {
  const { framing, killAfter = 2_000 } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const b = base(
    (m) => void child.stdin.write(encode(framing, m)),
    () => {
      child.stdin.end();
      if (child.kill && !timer) timer = setTimeout(() => child.kill!(), killAfter);
    },
  );
  child.stdout.on("data", createReader(framing, b.message));
  child.stdout.on("end", () => b.end());
  child.stdout.on("error", (e: Error) => b.end(e));
  child.stdin.on("error", (e: Error) => b.end(e)); // 죽은 프로세스에 쓰면 EPIPE
  child.on?.("exit", () => {
    clearTimeout(timer);
    b.end();
  });
  return b.transport;
}

type Timing = { pingMs: number; idleMs: number };

/** 프레임 하나가 메시지 하나. 열리기 전에 보낸 것은 열린 뒤 보낸다 */
export function websocket(url: string, options: { headers?: Record<string, string>; maxPayload?: number } = {}): Transport {
  const { pingMs, idleMs } = (options as { [TIMING]?: Timing })[TIMING] ?? DEFAULTS;
  const ws = new WebSocket(url, { headers: options.headers, maxPayload: options.maxPayload ?? 1024 * 1024 });
  const queue: string[] = [];
  let last = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let error: Error | undefined;
  let closing = false;
  const b = base(
    (m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(m);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(m);
    },
    () => {
      closing = true;
      ws.close();
    },
  );
  ws.on("open", () => {
    for (const m of queue.splice(0)) ws.send(m);
    last = Date.now();
    // 표준 ping 프레임 — 마지막 pong · 메시지에서 idleMs 가 지나면 끊는다
    timer = setInterval(() => {
      if (Date.now() - last < idleMs) return ws.ping();
      error = new Error(`${idleMs}ms 동안 pong 이 없다`);
      ws.terminate();
    }, pingMs);
  });
  ws.on("pong", () => (last = Date.now()));
  ws.on("message", (data) => {
    last = Date.now();
    b.message(data.toString());
  });
  ws.on("error", (e) => (error ??= e)); // 늘 close 가 뒤따른다
  ws.on("close", () => {
    clearInterval(timer);
    b.end(closing ? undefined : error);
  });
  return b.transport;
}
