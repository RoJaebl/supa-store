// 통로 위의 JSON-RPC 를 값과 요청 함수로 꺼낸다(스펙 §6 · §7 · §8) — 생명주기 · 준비 문 · onConnect · 다시 잇기
// 서버 전용이라 React 를 들이지 않는다. [USE] · retry() 는 두지 않는다
import { DISPOSE } from "../index.js";
import { TIMING, type ClientView } from "../stream/client.js";
import { DEFAULTS, TEXT } from "../stream/protocol.js";
import { RpcError } from "./error.js";
import { openSession, type Session } from "./session.js";
import type { Transport } from "./transport.js";

type Fn = (params: any) => unknown;
/** 돌려주는 객체가 쓰는 이름 — 요청 · 알림 이름으로 쓸 수 없다 */
type Reserved = "request" | "notify" | "view" | "subscribe" | "close";

/** onConnect 에 넘어오는 rpc — 준비 문을 거치지 않고 곧바로 보낸다 */
export interface ConnectRpc {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
}

/** 요청의 타입은 셋째 타입 인자로, method 와 제한 시간은 requests 에 — 이름마다 한 칸이 있어야 한다(없으면 타입 오류) */
export type JsonRpcOptions<V, N, Cmd, Names extends string> = {
  /** 처음 열 때와 다시 이을 때마다 부른다. 던지거나 거절하면 그 문구를 error 에 싣고 다시 부른다 */
  connect: () => Transport | Promise<Transport>;
  /** 열린 뒤 상대와 맞추고 이어 갈 값을 돌려준다. 생략하면 곧바로 준비되고 값은 마지막 값 그대로 */
  onConnect?: (last: V | undefined, rpc: ConnectRpc) => V | Promise<V>;
  reduce?: (value: V, note: N) => V;
  /** 이름마다 method — 정해진 이름(Reserved)은 쓰지 못한다 */
  notifications?: { [K in Names]: K extends Reserved ? never : string };
  /** 상대가 묻는 요청 — params 를 펼치지 않고 하나로 받는다 */
  handlers?: Record<string, (params: any) => unknown>;
  /** 「응답 지연」으로 끝낸 요청을 상대에게 알리는 알림 */
  cancel?: (id: number) => { method: string; params?: unknown };
  /** 기본 30초 */
  timeout?: number;
} & (keyof Cmd extends never
  ? { requests?: {} }
  : { requests: { [K in keyof Cmd]: K extends Reserved ? never : { method: string; timeout?: number } } });

export type JsonRpc<V, Cmd, Names extends string> = {
  /** 이름 붙지 않은 요청 — 준비 전이면 준비를 기다린다 */
  request(method: string, params?: unknown): Promise<unknown>;
  /** 준비 전이면 버리고 false */
  notify(method: string, params?: unknown): boolean;
  /** 바뀌지 않았으면 같은 객체 */
  view(): ClientView<V>;
  subscribe(fn: () => void): () => void;
  /** 통로를 닫고 다시 잇지 않는다 */
  close(): void;
  [DISPOSE](): void;
} & { [K in keyof Cmd]: (...params: Parameters<Extract<Cmd[K], Fn>>) => Promise<Awaited<ReturnType<Extract<Cmd[K], Fn>>>> } & {
  [K in Names]: (params?: unknown) => boolean;
};

/** 준비를 기다리는 요청 — 타이머는 부른 때부터 센다 */
type Waiting = {
  method: string;
  params: unknown;
  timeout: number;
  at: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(v: unknown): void;
  reject(e: unknown): void;
};

/** setTimeout 은 NaN · 2^31-1 넘는 값을 곧바로 터뜨린다 */
const timeable = (ms: number) => Number.isFinite(ms) && ms <= 2_147_483_647;

/** Names 는 notifications 의 이름들로 추론한다. 타입 인자를 적어 추론이 서지 않으면 string 이다 */
export function createJsonRpc<
  V,
  N extends { method: string; params?: unknown } = never,
  Cmd extends Record<keyof Cmd, Fn> = {},
  Names extends string = string,
>(o: JsonRpcOptions<V, N, Cmd, Names>): JsonRpc<V, Cmd, Names> {
  const firstGap = (o as { [TIMING]?: number })[TIMING] ?? DEFAULTS.backoffStartMs;
  const timeoutOf = (ms?: number) => ms ?? o.timeout ?? DEFAULTS.timeoutMs;
  const listeners = new Set<() => void>();
  const waiting = new Set<Waiting>();

  let data: V | undefined;
  /** 한 번이라도 준비됐나 — status 가 loading 을 벗어난다 */
  let wasReady = false;
  let session: Session | undefined;
  /** onConnect 가 끝났다 — 요청 · 알림이 곧바로 나간다 */
  let ready = false;
  /** 끊긴 뒤 아직 준비되지 않았다 */
  let broken = false;
  /** connect 가 던진 문구 — 다음 통로가 열리면 지운다 */
  let failure: string | undefined;
  let closed = false;
  /** 연결 하나마다 올린다 — 앞 연결의 늦은 알림 · 끝남은 이것과 견줘 버린다 */
  let gen = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let shown: ClientView<V> = { data, status: "loading", isFetching: true, error: null };

  const emit = () => {
    const next: ClientView<V> = closed
      ? { data, status: "ready", isFetching: false, error: null }
      : {
          data,
          status: wasReady ? "ready" : "loading",
          isFetching: !ready,
          error: failure ?? (broken ? TEXT.reconnecting : null),
        };
    if (
      next.data === shown.data &&
      next.status === shown.status &&
      next.isFetching === shown.isFetching &&
      next.error === shown.error
    )
      return;
    shown = next;
    for (const fn of [...listeners]) fn();
  };

  /** 1초부터 두 배, 30초에서 멈추고 ±20% 를 흔든다(0.3 client 의 backoff 와 같다) */
  const backoff = () => {
    const ms = Math.min(firstGap * 2 ** attempt++, DEFAULTS.backoffMaxMs);
    return Math.round(ms * (1 + DEFAULTS.jitter * (2 * Math.random() - 1)));
  };

  /** 그 연결을 버리고 다시 잇는다 — 세션을 닫으면 통로도 닫힌다(스스로 닫힌 통로여도 close 를 불러 stdio 가 자식을 거둔다) */
  const lost = (my: number, s?: Session, t?: Transport) => {
    if (my !== gen || closed) return;
    gen++;
    session = undefined;
    ready = false;
    broken = true;
    s?.close();
    t?.close();
    retry = setTimeout(open, backoff());
    emit();
  };

  const send = (w: Waiting, s: Session) => {
    waiting.delete(w);
    clearTimeout(w.timer);
    s.request(w.method, w.params, Math.max(0, w.timeout - (Date.now() - w.at)), o.cancel).then(w.resolve, w.reject);
  };

  const becomeReady = (my: number, s: Session, value: V | undefined, notes: N[]) => {
    if (my !== gen || closed) return;
    data = value;
    if (o.reduce) for (const n of notes) data = o.reduce(data as V, n);
    notes.length = 0;
    ready = wasReady = true;
    broken = false;
    attempt = 0;
    for (const w of [...waiting]) send(w, s);
    emit();
  };

  const attach = (my: number, t: Transport) => {
    if (my !== gen || closed) return t.close(); // 기다리는 동안 닫혔다
    failure = undefined;
    /** onConnect 도중 받은 알림 — 준비되면 돌려준 값 위에 쌓는다 */
    const notes: N[] = [];
    const s = openSession(t, {
      handlers: o.handlers,
      onNotification: (n) => {
        if (my !== gen) return;
        if (!ready) return void notes.push(n as N);
        if (!o.reduce) return;
        data = o.reduce(data as V, n as N);
        emit();
      },
      onClose: () => lost(my, undefined, t),
    });
    session = s;
    if (!o.onConnect) return becomeReady(my, s, data, notes);
    const rpc: ConnectRpc = {
      request: (method, params) => s.request(method, params, timeoutOf(), o.cancel),
      notify: (method, params) => s.notify(method, params),
    };
    new Promise<V>((r) => r(o.onConnect!(data, rpc))).then(
      (v) => becomeReady(my, s, v, notes),
      () => lost(my, s),
    );
    emit();
  };

  const open = () => {
    retry = undefined;
    const my = ++gen;
    const failed = (e: unknown) => {
      if (my !== gen || closed) return;
      failure = e instanceof Error ? e.message : String(e);
      lost(my);
    };
    let r: Transport | Promise<Transport>;
    try {
      r = o.connect();
    } catch (e) {
      return failed(e);
    }
    if (typeof (r as { then?: unknown }).then === "function")
      (r as Promise<Transport>).then((t) => attach(my, t), failed);
    else attach(my, r as Transport);
  };

  const request = (method: string, params: unknown, timeout: number): Promise<unknown> => {
    if (closed) return Promise.reject(new RpcError(TEXT.commandFailed, 0));
    if (ready) return session!.request(method, params, timeout, o.cancel);
    return new Promise((resolve, reject) => {
      const w: Waiting = { method, params, timeout, at: Date.now(), resolve, reject };
      waiting.add(w);
      // 보내기 전이라 id 가 없다 — requestId 0
      if (timeable(timeout))
        w.timer = setTimeout(() => {
          waiting.delete(w);
          reject(new RpcError(TEXT.timeout, 0));
        }, timeout);
    });
  };
  const notify = (method: string, params?: unknown) => {
    if (!ready || closed) return false;
    session!.notify(method, params);
    return true;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    gen++;
    clearTimeout(retry);
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(new RpcError(TEXT.commandFailed, 0));
    }
    waiting.clear();
    session?.close();
    session = undefined;
    ready = false;
    emit();
  };

  const out: Record<string | symbol, unknown> = {};
  for (const [name, r] of Object.entries((o.requests ?? {}) as Record<string, { method: string; timeout?: number }>))
    out[name] = (params?: unknown) => request(r.method, params, timeoutOf(r.timeout));
  for (const [name, method] of Object.entries((o.notifications ?? {}) as Record<string, string>))
    out[name] = (params?: unknown) => notify(method, params);
  Object.assign(out, {
    request: (method: string, params?: unknown) => request(method, params, timeoutOf()),
    notify,
    view: () => shown,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    close,
    [DISPOSE]: close,
  });

  open();
  return out as JsonRpc<V, Cmd, Names>;
}
