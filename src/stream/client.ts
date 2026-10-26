// 화면 쪽 연결(스펙 §7 · §8) — 웹소켓 · SSE(fetch 스트림)로 홉에 붙어 값을 따라가고 명령을 보낸다
// 다시 잇기 · 따라잡기 · 명령의 답을 여기서 맡는다. node · React 의 어느 것도 들이지 않는다(전역 WebSocket · fetch)
import { CLOSE, DEFAULTS, HEADER, TEXT, type ClientMessage, type Outcome, type ServerMessage } from "./protocol.js";

export interface ClientOptions<V, C> {
  /** 웹소켓은 ws(s)://, SSE 는 http(s):// — 한 path 가 GET · POST 를 함께 받는다 */
  url: string;
  transport?: "ws" | "sse";
  /** 생략하면 "default" */
  channel?: string;
  /** 다시 이을 때마다 부른다. 웹소켓은 hello.auth, SSE · POST 는 Authorization 헤더 — 주소에는 싣지 않는다 */
  auth?: () => string | Promise<string>;
  /** 생략하면 change 를 새 값 전체로 본다 */
  reduce?: (value: V, change: C) => V;
  /** 명령의 답을 기다리는 시간 — 기본 30초 */
  timeout?: number;
  commands?: Record<string, { timeout?: number }>;
  /** 서버의 request 에 답한다(§7.6) */
  handlers?: Record<string, (...params: any[]) => unknown>;
}

/** §8.3 의 표 그대로 — 연결 상태를 따로 담는 칸은 두지 않는다 */
export interface ClientView<V> {
  data: V | undefined;
  status: "loading" | "ready" | "error";
  isFetching: boolean;
  error: string | null;
}

export interface StreamClient<V> {
  /** 바뀌지 않았으면 같은 객체 */
  view(): ClientView<V>;
  subscribe(fn: () => void): () => void;
  /** id 를 주면 그 id 로 보낸다(retry) — 홉이 이미 처리한 id 면 다시 돌리지 않고 쥔 답을 준다 */
  command(name: string, args: unknown[], id?: string): Promise<unknown>;
  close(): void;
}

/** 명령의 실패 — message 는 TEXT 의 문구 또는 서버 앱의 문구, requestId 는 같은 id 로 다시 보낼 때 */
export type CommandError = Error & { requestId: string };

/** 연결 하나 — 끊기면 버리고 새로 짓는다. 앞 연결의 늦은 메시지는 cur 와 견줘 버린다 */
interface Link {
  send(m: ClientMessage): void;
  stop(): void;
  welcomed: boolean;
  /** welcome.version 까지 따라잡았다 — 그 뒤의 4000 · 건너뛰기만 곧바로 다시 잇는다 */
  caught?: boolean;
  /** welcome.connection — SSE 의 POST 가 싣는다 */
  connection?: string;
  idle?: ReturnType<typeof setTimeout>;
}

interface Pending {
  id: string;
  name: string;
  args: unknown[];
  /** 마지막으로 보낸(또는 물은) 연결 */
  link: Link;
  timeout: number;
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<unknown>;
  resolve(v: unknown): void;
  reject(e: Error): void;
  /** 답은 받았고 data 가 이 버전에 이르기를 기다린다 */
  wait?: { version: number; result: unknown };
}

const failure = (message: string, requestId: string): CommandError => Object.assign(new Error(message), { requestId });

/** 요청 id — randomUUID 는 보안 문맥(https · localhost)에만 있으므로 http://LAN-IP 에서는 getRandomValues 로 */
const newId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** 시험 전용 — 다시 잇기의 첫 간격(ms)을 줄인다. 하위 경로로 내보내지 않는다 */
export const TIMING = Symbol("supa-store.timing");

/** SSE 본문 읽기 — 조각을 받아 이벤트마다 data 줄을 \n 으로 이어 넘긴다
 *  줄 끝은 \r\n · \r · \n 모두, : 로 시작하는 줄은 주석, data 밖의 칸(id · event · retry)은 버린다 */
export function sseParser(onData: (data: string) => void): (chunk: string) => void {
  let buf = "";
  let data: string[] = [];
  return (chunk) => {
    buf += chunk;
    for (;;) {
      const at = buf.search(/[\r\n]/);
      if (at < 0) return;
      // 끝의 \r 은 다음 조각의 \n 과 한 줄 끝일 수 있으므로 기다린다
      if (buf[at] === "\r" && at === buf.length - 1) return;
      const line = buf.slice(0, at);
      buf = buf.slice(at + (buf[at] === "\r" && buf[at + 1] === "\n" ? 2 : 1));
      if (line === "") {
        if (data.length) onData(data.join("\n"));
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field === "data") data.push(colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, ""));
      }
    }
  };
}

export function connect<V, C>(o: ClientOptions<V, C>): StreamClient<V> {
  const channel = o.channel ?? "default";
  const firstGap = (o as { [TIMING]?: number })[TIMING] ?? DEFAULTS.backoffStartMs;
  const listeners = new Set<() => void>();
  const pending = new Map<string, Pending>();

  let data: V | undefined;
  /** 값을 한 번이라도 받았나 — data 가 undefined 인 값도 있으므로 따로 든다 */
  let has = false;
  /** 가진 버전, 없으면 -1 */
  let version = -1;
  let epoch: string | undefined;
  /** welcome.version — 여기에 이르면 따라잡기가 끝난다 */
  let target = 0;
  /** 끊긴 뒤 아직 따라잡지 못했다 — error 에 재시도 중 */
  let broken = false;
  /** 「다시 오지 마라」의 까닭 — 서면 다시 잇지 않는다 */
  let dead: string | undefined;
  let closed = false;
  let cur: Link | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let shown: ClientView<V> = { data, status: "loading", isFetching: true, error: null };

  const emit = () => {
    const caught = !!cur?.welcomed && version >= target;
    if (caught) {
      // 따라잡아야 이어진 것으로 친다 — 그때 간격을 1초로 되돌린다
      broken = false;
      cur!.caught = true;
      attempt = 0;
    }
    const next: ClientView<V> =
      dead !== undefined
        ? { data, status: "error", isFetching: false, error: dead }
        : { data, status: has ? "ready" : "loading", isFetching: !caught, error: broken ? TEXT.reconnecting : null };
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

  // ── 명령 ──
  const fail = (p: Pending, message: string) => {
    clearTimeout(p.timer);
    pending.delete(p.id);
    p.reject(failure(message, p.id));
  };
  const finish = (p: Pending) => {
    clearTimeout(p.timer);
    pending.delete(p.id);
    p.resolve(p.wait!.result);
  };
  /** 제한 시간을 (다시) 센다 — 끊긴 채 지나면 결과를 확인하지 못한 것 */
  const arm = (p: Pending) => {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => fail(p, p.link === cur ? TEXT.timeout : TEXT.unknown), p.timeout);
  };
  const send = (p: Pending) => p.link.send({ t: "command", id: p.id, name: p.name, args: p.args });

  /** reply · fate — 명령은 그 명령이 낸 바뀜이 data 에 든 뒤에 끝난다(§7.4) */
  const answered = (m: Extract<ServerMessage, { t: "reply" | "fate" }>) => {
    const p = pending.get(m.id);
    if (!p || p.wait) return;
    if (m.t === "fate" && m.state === "unknown-id") return fail(p, TEXT.commandFailed);
    if (m.t === "fate" && m.state === "running") {
      // 같은 id 로 다시 보내면 홉은 돌리지 않고 도는 중인 그 답을 이 연결로 준다
      arm(p);
      return send(p);
    }
    const out = m as Outcome & { version: number };
    // ok: false 는 version 0 — data 를 기다리지 않는다(연결의 약속 11)
    if (!out.ok) return fail(p, out.error);
    p.wait = { version: out.version, result: out.result };
    if (version >= out.version) finish(p);
  };

  /** 서버의 request 를 handlers 로 — 없는 이름 · 던짐은 ok: false */
  const serve = async (link: Link, m: Extract<ServerMessage, { t: "request" }>) => {
    const fn = o.handlers && Object.hasOwn(o.handlers, m.method) ? o.handlers[m.method] : undefined;
    let out: Outcome;
    if (!fn) out = { ok: false, error: `알 수 없는 요청: ${m.method}` };
    else
      try {
        out = { ok: true, result: await fn(...m.params) };
      } catch (e) {
        out = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    if (cur === link) link.send({ t: "answer", id: m.id, ...out });
  };

  // ── 연결 ──
  /** 아무것도 받지 못한 채 60초면 끊긴 것 */
  const watch = (link: Link) => {
    if (cur !== link) return;
    clearTimeout(link.idle);
    link.idle = setTimeout(() => lost(link), DEFAULTS.idleMs);
  };

  /** 1초부터 두 배, 30초에서 멈추고 ±20% 를 흔든다 */
  const backoff = () => {
    const ms = Math.min(firstGap * 2 ** attempt++, DEFAULTS.backoffMaxMs);
    return Math.round(ms * (1 + DEFAULTS.jitter * (2 * Math.random() - 1)));
  };

  /** 그 연결이 끊겼다 — 4001 이면 멈추고, 아니면 다시 잇는다 */
  const lost = (link: Link, code?: number, reason = "") => {
    if (cur !== link) return;
    cur = undefined;
    clearTimeout(link.idle);
    link.stop();
    if (code === CLOSE.GO_AWAY) {
      dead = reason;
      for (const p of [...pending.values()]) fail(p, TEXT.unknown);
      return emit();
    }
    broken = true;
    // 「곧 다시 와라」 · 건너뛰기는 곧바로 — 따라잡은 적 없는 연결이면(welcome 뒤 snapshot 이 실패한 4000 등) 늦춘다.
    // welcome 만 보고 곧바로 다시 이으면 늘 실패하는 홉에 쉼 없이 몰린다
    retry = setTimeout(open, code === CLOSE.COME_BACK && link.caught ? 0 : backoff());
    emit();
  };

  const receive = (link: Link, m: ServerMessage) => {
    if (cur !== link) return; // 앞 연결의 늦은 메시지
    switch (m.t) {
      case "welcome": {
        // 서버가 다시 떴다 — 버전이 0 부터 다시 세므로 가진 버전을 버리고 snapshot 을 기다린다
        const fresh = epoch !== undefined && m.epoch !== epoch;
        epoch = m.epoch;
        target = m.version;
        link.welcomed = true;
        link.connection = m.connection;
        if (fresh) version = -1;
        const asked: string[] = [];
        for (const p of [...pending.values()]) {
          if (p.link === link) continue;
          // 서버가 기록을 잃었으니 확인할 길이 없다. 답을 받아 data 를 기다리던 것은 snapshot 이 끝낸다
          if (fresh && !p.wait) {
            fail(p, TEXT.unknown);
            continue;
          }
          p.link = link;
          arm(p);
          if (!p.wait) asked.push(p.id);
        }
        if (asked.length) link.send({ t: "ask", ids: asked });
        break;
      }
      case "snapshot":
        data = m.value as V;
        has = true;
        version = m.version;
        // 값 전체를 받았으니 기다리던 명령의 바뀜도 들어 있다
        for (const p of [...pending.values()]) if (p.wait) finish(p);
        break;
      case "change":
        if (m.version <= version) return;
        // 하나 넘게 건너뛰었다 — 다시 이어 hello 로 따라잡는다
        if (m.version > version + 1) return lost(link, CLOSE.COME_BACK);
        data = o.reduce ? o.reduce(data as V, m.change as C) : (m.change as V);
        version = m.version;
        for (const p of [...pending.values()]) if (p.wait && p.wait.version <= version) finish(p);
        break;
      case "reply":
      case "fate":
        return answered(m);
      case "request":
        return void serve(link, m);
      case "ping":
        if (o.transport !== "sse") link.send({ t: "pong" });
        return;
      case "close":
        return lost(link, m.code, m.reason);
    }
    emit();
  };

  const open = async () => {
    retry = undefined;
    const link: Link = { welcomed: false, send() {}, stop() {} };
    cur = link;
    let token: string | undefined;
    try {
      token = await o.auth?.();
      if (cur !== link) return; // 기다리는 동안 닫혔다
      (o.transport === "sse" ? sse : ws)(link, token);
    } catch {
      return lost(link);
    }
    watch(link);
  };

  const ws = (link: Link, token: string | undefined) => {
    const sock = new WebSocket(o.url);
    sock.onopen = () =>
      sock.send(JSON.stringify({ t: "hello", channel, auth: token, ...(version >= 0 ? { version, epoch } : {}) }));
    sock.onmessage = (e) => {
      watch(link);
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      receive(link, m);
    };
    sock.onclose = (e) => lost(link, e.code, e.reason);
    link.send = (m) => void (sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(m)));
    link.stop = () => {
      sock.onopen = sock.onmessage = sock.onclose = null;
      sock.close();
    };
  };

  /** SSE — GET 의 헤더가 hello 다. 받기는 fetch 본문을 빈 줄로 나눠 읽고, 보내기는 POST 다 */
  const sse = (link: Link, token: string | undefined) => {
    // POST 도 같은 신호로 — 연결을 버리면 날아가는 POST 도 함께 끊는다
    const abort = new AbortController();
    link.stop = () => abort.abort();
    link.send = (m) => void post(link, m, abort.signal, { [HEADER.channel]: channel, [HEADER.connection]: link.connection ?? "" });

    const headers: Record<string, string> = { [HEADER.channel]: channel, accept: "text/event-stream" };
    if (token) headers[HEADER.authorization] = `Bearer ${token}`;
    if (version >= 0) {
      headers[HEADER.epoch] = epoch!;
      headers[HEADER.lastEventId] = String(version);
    }
    void (async () => {
      const res = await fetch(o.url, { headers, signal: abort.signal });
      // 연결 때 401 · 403 은 「다시 오지 마라」와 같다
      if (res.status === 401 || res.status === 403) return lost(link, CLOSE.GO_AWAY, await res.text());
      if (!res.ok || !res.body) return lost(link);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      // 망가진 프레임은 버린다 — 웹소켓과 같게 연결은 살린다
      const feed = sseParser((data) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(data);
        } catch {
          return;
        }
        receive(link, m);
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // 스트림에서 받은 것만 idle 을 다시 센다 — POST 의 응답은 GET 이 살아 있다는 뜻이 아니다
        watch(link);
        feed(value);
      }
      lost(link);
    })().catch(() => lost(link));
  };

  /** command 의 응답은 reply, ask 는 fate 의 배열 — 받은 길과 같게 receive 로 넘긴다 */
  const post = async (link: Link, m: ClientMessage, signal: AbortSignal, headers: Record<string, string>) => {
    let res: Response;
    let body: string;
    // POST 마다 auth() 를 다시 부른다 — 짧게 사는 토큰이 갱신되면 연 때의 것이 아니라 새 것을 싣는다
    // auth() 가 던지면 토큰 없이 보낸다 — 홉이 거절하면 아래의 막힌 길로 간다
    const token = await Promise.resolve()
      .then(() => o.auth?.())
      .catch(() => undefined);
    if (token) headers = { ...headers, [HEADER.authorization]: `Bearer ${token}` };
    try {
      res = await fetch(o.url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(m),
        signal,
      });
      body = await res.text();
    } catch {
      return; // 닿았는지 모른다 — 스트림이 끊기면 다시 이어 ask 로 묻는다
    }
    if (res.status === 200) {
      let out: ServerMessage | ServerMessage[];
      try {
        out = JSON.parse(body);
      } catch {
        return;
      }
      for (const x of [out].flat()) receive(link, x);
    } else if (m.t === "command")
      // 400 · 401 · 403 · 404 · 500 — 홉이 명령을 돌리기 전에 막았다
      receive(link, { t: "reply", id: m.id, ok: false, error: TEXT.commandFailed, version: 0 });
    else if (m.t === "ask" && cur === link)
      // 물을 길이 막혔다 — 제한 시간까지 「응답 지연」으로 기다리게 두지 않는다
      for (const id of m.ids) {
        const p = pending.get(id);
        if (p && !p.wait) fail(p, TEXT.unknown);
      }
  };

  void open();

  return {
    view: () => shown,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    command(name, args, id = newId()) {
      const had = pending.get(id);
      if (had) return had.promise;
      const link = cur;
      // 끊긴 동안 · welcome 전에는 보내지 않는다 — 쥐었다 다시 보내지 않는다
      if (!link?.welcomed) return Promise.reject(failure(TEXT.commandFailed, id));
      const p = { id, name, args, link, timeout: o.commands?.[name]?.timeout ?? o.timeout ?? DEFAULTS.timeoutMs } as Pending;
      p.promise = new Promise((resolve, reject) => Object.assign(p, { resolve, reject }));
      pending.set(id, p);
      arm(p);
      send(p);
      return p.promise;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retry);
      const link = cur;
      cur = undefined;
      if (link) {
        clearTimeout(link.idle);
        link.stop();
      }
      for (const p of [...pending.values()]) fail(p, TEXT.unknown);
      listeners.clear();
    },
  };
}
