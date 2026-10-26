// 통로 하나 위의 JSON-RPC 2.0 — 요청 · 답 · 알림 · 상대의 요청. 상대가 무엇을 보내도 던지거나 닫지 않는다
import { TEXT } from "../stream/protocol.js";
import { RpcError } from "./error.js";
import type { Transport } from "./transport.js";

export interface Session {
  request(
    method: string,
    params: unknown,
    timeout: number,
    cancel?: (id: number) => { method: string; params?: unknown },
  ): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export interface SessionOptions {
  handlers?: Record<string, (params: any) => unknown>;
  onNotification(n: { method: string; params?: unknown }): void;
  onClose(): void;
}

type Pending = {
  resolve(v: unknown): void;
  reject(e: RpcError): void;
  timer?: ReturnType<typeof setTimeout>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";

export function openSession(t: Transport, o: SessionOptions): Session {
  const pending = new Map<number, Pending>();
  let next = 1;
  /** 닫힌 까닭의 문구 — 비어 있으면 열려 있다 */
  let ended: string | undefined;

  const send = (m: object) => t.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
  const fail = (text: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(text, id));
    }
    pending.clear();
  };

  const answer = (id: string | number, method: string, params: unknown) => {
    const h = o.handlers && Object.hasOwn(o.handlers, method) ? o.handlers[method] : undefined;
    if (!h) return send({ id, error: { code: -32601, message: "Method not found" } });
    const internal = (e: unknown) => ({ error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    /** 값이 글자로 바뀌지 않으면(BigInt · 순환) 그 문구로 답한다 */
    const reply = (m: object) => {
      try {
        send({ id, ...m });
      } catch (e) {
        send({ id, ...internal(e) });
      }
    };
    new Promise((r) => r(h(params))).then(
      (result) => reply({ result: result ?? null }),
      (e) => reply(internal(e)),
    );
  };

  const handle = (m: unknown) => {
    if (!isObject(m)) return;
    if (typeof m.method === "string") {
      if (m.id === undefined) {
        try {
          o.onNotification("params" in m ? { method: m.method, params: m.params } : { method: m.method });
        } catch {}
      } else if (isId(m.id)) answer(m.id, m.method, m.params);
      return;
    }
    const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
    if (!p || !("result" in m || isObject(m.error))) return; // 늦은 답 · 모르는 id · 답이 아닌 꼴
    const id = m.id as number;
    pending.delete(id);
    clearTimeout(p.timer);
    if (isObject(m.error)) {
      const { message, code, data } = m.error;
      const c = typeof code === "number" ? code : undefined;
      const text = typeof message === "string" ? message : c === undefined ? "상대 오류" : `상대 오류 ${c}`;
      p.reject(new RpcError(text, id, c, data));
    } else p.resolve(m.result);
  };

  t.onMessage((text) => {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    for (const one of Array.isArray(m) ? m : [m]) handle(one);
  });
  t.onClose(() => {
    if (ended === undefined) ended = TEXT.unknown;
    fail(ended);
    o.onClose();
  });

  return {
    request(method, params, timeout, cancel) {
      const id = next++;
      if (ended !== undefined) return Promise.reject(new RpcError(ended, id));
      return new Promise((resolve, reject) => {
        const p: Pending = { resolve, reject };
        pending.set(id, p);
        try {
          send({ id, method, params });
        } catch (e) {
          pending.delete(id); // params 가 글자로 바뀌지 않으면 남기지 않고 그 오류로 거절한다
          throw e;
        }
        // setTimeout 은 NaN · 2^31-1 넘는 값을 곧바로 터뜨린다
        if (Number.isFinite(timeout) && timeout <= 2_147_483_647)
          p.timer = setTimeout(() => {
            pending.delete(id);
            reject(new RpcError(TEXT.timeout, id));
            try {
              if (cancel) send(cancel(id));
            } catch {}
          }, timeout);
      });
    },
    notify: (method, params) => send(params === undefined ? { method } : { method, params }),
    close() {
      if (ended !== undefined) return;
      ended = TEXT.commandFailed;
      fail(ended);
      t.close();
    },
  };
}
