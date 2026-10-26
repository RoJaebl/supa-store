// supa-store/stream — 서버와 이어진 연결을 store 상태로 꺼낸다(스펙 §6 · §8)
// 정의 파일은 서버에서도 평가되므로 "use client" 를 두지 않는다. 시험 전용(TIMING · sseParser)은 내보내지 않는다
import { DISPOSE, USE } from "../index.js";
import type { MutationView } from "../query.js";
import { connect, type ClientOptions, type ClientView, type CommandError, type StreamClient } from "./client.js";
import { makeStreamHook } from "./hook.js";
import { TEXT } from "./protocol.js";

export type { ClientView, CommandError };

type Fn = (...args: any[]) => any;

export interface StreamCommandView<F extends Fn> extends MutationView<F> {
  /** 마지막으로 실패한 명령을 같은 요청 id · 인자로 다시 보낸다. 실패한 명령이 없으면 거절한다 */
  retry(): Promise<Awaited<ReturnType<F>>>;
}
/** 화면이 꺼내는 칸 — 연결의 값(§8.3)과 명령마다의 칸 */
export type StreamView<V, Cmd> = ClientView<V> & { [K in keyof Cmd]: StreamCommandView<Extract<Cmd[K], Fn>> };
type Name<V, Cmd> = keyof StreamView<V, Cmd> & string;
export type StreamUseOptions<V, Cmd> =
  | { pick: readonly Name<V, Cmd>[]; omit?: never }
  | { omit: readonly Name<V, Cmd>[]; pick?: never }
  | undefined;
// [O] 로 감싸 유니온에 나눠 걸지 않는다
export type StreamUseResult<V, Cmd, O> = [O] extends [{ pick: readonly (infer N)[] }]
  ? Pick<StreamView<V, Cmd>, N & keyof StreamView<V, Cmd>>
  : [O] extends [{ omit: readonly (infer N)[] }]
    ? Omit<StreamView<V, Cmd>, N & keyof StreamView<V, Cmd>>
    : StreamView<V, Cmd>;
export interface StreamUse<V, Cmd> {
  <O extends StreamUseOptions<V, Cmd>>(options?: O): StreamUseResult<V, Cmd, O>;
}
/** store 상태 — 화면은 useStore 로, store 끼리는 명령 함수로 부른다(실패하면 던진다) */
export type Stream<V, Cmd> = { [USE]: StreamUse<V, Cmd>; [DISPOSE](): void } & {
  [K in keyof Cmd]: (...args: Parameters<Extract<Cmd[K], Fn>>) => Promise<Awaited<ReturnType<Extract<Cmd[K], Fn>>>>;
};

/**
 * 명령의 타입은 셋째 타입 인자로 적고, 이름과 제한 시간은 commands 에 적는다 — 타입은 런타임에 남지 않으므로
 * 명령마다 commands 에 한 칸이 있어야 한다(없으면 타입 오류)
 */
export type StreamOptions<V, C, Cmd> = Omit<ClientOptions<V, C>, "commands"> & {
  /** 기본 "browser" — window 가 없으면(서버에서 그릴 때) 열지 않는다. "always" 면 Node 에서도 연다 */
  open?: "browser" | "always";
} & (keyof Cmd extends never ? { commands?: {} } : { commands: { [K in keyof Cmd]: { timeout?: number } } });

/** 상대 주소는 location 으로 푼다 — 웹소켓이면 http → ws, https → wss */
function absolute(url: string, transport: "ws" | "sse" | undefined): string {
  if (URL.canParse(url)) return url;
  if (typeof location === "undefined" || !location)
    throw new Error(`상대 주소를 풀 location 이 없다: ${url} — ws(s):// 또는 http(s):// 로 적는다`);
  const u = new URL(url, location.href);
  if (transport !== "sse") u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

/** 서버에서 그릴 때의 연결 — 열지 않으므로 loading 그대로이고 명령은 실패한다 */
const IDLE_VIEW: ClientView<never> = { data: undefined, status: "loading", isFetching: true, error: null };
const idle: StreamClient<never> = {
  view: () => IDLE_VIEW,
  subscribe: () => () => {},
  command: (_name, _args, id = "") => Promise.reject(Object.assign(new Error(TEXT.commandFailed), { requestId: id })),
  close() {},
};

export function createStream<V, C = V, Cmd extends Record<keyof Cmd, Fn> = {}>(o: StreamOptions<V, C, Cmd>): Stream<V, Cmd> {
  const names = Object.keys(o.commands ?? {});
  const client: StreamClient<unknown> =
    typeof window === "undefined" && o.open !== "always"
      ? idle
      : connect({ ...o, url: absolute(o.url, o.transport) } as ClientOptions<unknown, unknown>);
  const state: Record<string | symbol, unknown> = {
    [USE]: makeStreamHook(client, names),
    // 다시 짓기 직전 · disposeStores 에서 — 앞 연결의 늦은 메시지는 닫힌 클라이언트가 버린다
    [DISPOSE]: () => client.close(),
  };
  for (const name of names) state[name] = (...args: unknown[]) => client.command(name, args);
  return state as Stream<V, Cmd>;
}
