// 통로를 여는 도우미(스펙 §6.2) — 표준 입출력을 가진 프로세스와 웹소켓. ws 는 선택 peer 라 websocket() 을 부를 때에야 들인다(stdio 만 쓰면 없어도 된다)
import type { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import type { WebSocket as WS } from "ws";
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

/** 듣는 이를 모아 알린다 — 쓰는 쪽이 던져도 읽기를 끊지 않는다
 *  close() 뒤의 send 는 버리고, 우리가 닫았으면 reason 을 비운다. onClose 뒤에는 메시지를 알리지 않는다 */
function base(send: (m: string) => void, close: () => void) {
  const onMessage = new Set<(m: string) => void>();
  const onClose = new Set<(r?: Error) => void>();
  let ended = false;
  let closing = false;
  const transport: Transport = {
    send: (m) => {
      if (!ended && !closing) send(m);
    },
    onMessage: (fn) => void onMessage.add(fn),
    onClose: (fn) => void onClose.add(fn),
    close: () => {
      if (closing) return;
      closing = true;
      close();
    },
  };
  const message = (m: string) => {
    if (ended) return;
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
        fn(closing ? undefined : reason);
      } catch {}
    }
  };
  return { transport, message, end, ended: () => ended };
}

export interface StdioChild {
  stdin: Writable;
  stdout: Readable;
  kill?(): unknown;
  /** ChildProcess 면 'close'(표준 입출력이 다 닫힌 뒤)를 끝남으로, 'error'(실행 파일이 없다 따위)를 그 까닭으로 본다 */
  on?(event: "close" | "error", fn: (e?: Error) => void): unknown;
}

/** close() 는 표준 입력을 닫고, kill 이 있으면 killAfter 안에 끝나지 않을 때 kill 한다 */
export function stdio(child: StdioChild, options: { framing: Framing; killAfter?: number }): Transport {
  const { framing, killAfter = 2_000 } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 프로세스가 끝났나 — 통로가 끝난 것(출력 end)과는 따로 든다. 출력만 닫고 사는 프로세스도 거둬야 한다 */
  let exited = false;
  const b = base(
    (m) => void child.stdin.write(encode(framing, m)),
    () => {
      child.stdin.end();
      if (!child.kill || exited) return;
      timer = setTimeout(() => child.kill!(), killAfter);
      timer.unref?.();
    },
  );
  const exit = (e?: Error) => {
    exited = true;
    clearTimeout(timer);
    b.end(e);
  };
  child.stdout.on("data", createReader(framing, b.message));
  child.stdout.on("end", () => b.end());
  child.stdout.on("error", (e: Error) => b.end(e));
  child.stdin.on("error", (e: Error) => b.end(e)); // 죽은 프로세스에 쓰면 EPIPE
  child.on?.("close", () => exit());
  child.on?.("error", exit); // 듣지 않으면 spawn 의 ENOENT 가 앱을 죽인다
  return b.transport;
}

type Timing = { pingMs: number; idleMs: number };

/** 프레임 하나가 메시지 하나. 열리기 전에 보낸 것은 열린 뒤 보낸다. url 이 틀리면 동기로 던진다(ws 의 생성자) */
export function websocket(url: string, options: { headers?: Record<string, string>; maxPayload?: number } = {}): Transport {
  const { pingMs, idleMs } = (options as { [TIMING]?: Timing })[TIMING] ?? DEFAULTS;
  const { WebSocket } = createRequire(import.meta.url)("ws") as { WebSocket: typeof WS };
  const ws = new WebSocket(url, { headers: options.headers, maxPayload: options.maxPayload ?? 1024 * 1024 });
  const queue: string[] = [];
  let ping: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let error: Error | undefined;
  const b = base(
    (m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(m);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(m);
    },
    () => ws.close(),
  );
  /** 살아 있음을 볼 때마다 다시 센다 — 마지막으로 본 뒤 idleMs 면 끊는다(0.3 client 의 watch 와 같은 꼴) */
  const watch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      error = new Error(`${idleMs}ms 동안 pong 이 없다`);
      ws.terminate();
    }, idleMs);
  };
  ws.on("open", () => {
    for (const m of queue.splice(0)) ws.send(m);
    watch();
    ping = setInterval(() => ws.ping(), pingMs); // 표준 ping 프레임
  });
  ws.on("pong", watch);
  ws.on("message", (data) => {
    watch();
    b.message(data.toString());
  });
  ws.on("error", (e) => (error ??= e)); // 늘 close 가 뒤따른다
  ws.on("close", () => {
    clearInterval(ping);
    clearTimeout(idle);
    b.end(error);
  });
  return b.transport;
}
