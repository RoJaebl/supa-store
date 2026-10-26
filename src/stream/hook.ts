// 연결의 화면 훅 — 정의 파일과 함께 서버 쪽에서도 평가되므로 "use client" 를 두지 않고 React 를 이름공간으로 가져온다
import * as React from "react";
import type { MutationView } from "../query.js";
import { same, subscribeNone, useMutation } from "../resourceHook.js";
import type { ClientView, CommandError, StreamClient } from "./client.js";

type Fn = (...args: any[]) => any;
type Options = { pick?: readonly string[]; omit?: readonly string[] };

export const STREAM_FIELDS = ["data", "status", "isFetching", "error"];
export const NO_FAILURE = "다시 보낼 실패한 명령이 없다";

export function makeStreamHook(client: StreamClient<unknown>, names: string[]): (options?: Options) => unknown {
  return function useStream(options?: Options) {
    const shown = options?.pick ?? [...STREAM_FIELDS, ...names].filter((n) => !options?.omit?.includes(n));
    const fields = shown.filter((n) => STREAM_FIELDS.includes(n));
    // 고른 칸이 겉 한 겹으로 그대로면 앞 결과를 준다 — isFetching 만 바뀌어도 data 만 고른 화면은 다시 그리지 않는다
    const last = React.useRef<Record<string, unknown> | null>(null);
    const snapshot = () => {
      const v = client.view() as ClientView<unknown> & Record<string, unknown>;
      const prev = last.current;
      if (prev && Object.keys(prev).length === fields.length && fields.every((f) => f in prev && same(prev[f], v[f])))
        return prev;
      const out: Record<string, unknown> = {};
      for (const f of fields) out[f] = v[f];
      return (last.current = out);
    };
    const item = React.useSyncExternalStore(fields.length ? client.subscribe : subscribeNone, snapshot, snapshot);

    // 명령마다 훅을 정해진 차례로 부른다 — 고르기와 상관없이 훅 순서가 같다
    const views: Record<string, unknown> = {};
    for (const name of names) views[name] = useCommand(client, name);

    if (!shown.some((n) => names.includes(n))) return item;
    const out: Record<string, unknown> = {};
    for (const name of shown) out[name] = name in item ? item[name] : views[name];
    return out;
  };
}

/** 0.2 의 MutationView 에 retry 를 더한다 — 이 화면의 이 명령 칸에서 마지막 실패의 요청 id · 인자만 쥔다(스펙 §14 의 21) */
function useCommand(client: StreamClient<unknown>, name: string): MutationView<Fn> {
  const failed = React.useRef<{ id: string; args: unknown[] } | null>(null);
  const send = (args: unknown[], id?: string) =>
    client.command(name, args, id).then(
      (data) => {
        // 다시 보낸 것이 풀렸다 — 다시 보낼 실패가 없다
        if (id !== undefined && failed.current?.id === id) failed.current = null;
        return data;
      },
      (e: CommandError) => {
        failed.current = { id: e.requestId, args };
        throw e;
      },
    );
  return useMutation(
    (...args: unknown[]) => send(args),
    (run) => ({
      // 같은 id 면 홉은 다시 돌리지 않고 쥔 답을 준다. 앱의 ok: false 는 같은 실패가 돌아온다 — 새로 부르려면 mutate
      retry() {
        const f = failed.current;
        return f ? run(() => send(f.args, f.id)) : Promise.reject(new Error(NO_FAILURE));
      },
    }),
  );
}
