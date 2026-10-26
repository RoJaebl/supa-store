// 서버의 홉 — 채널 · epoch · 버전 · 기록 · 답 기록 · ask · heartbeat · authorize · snapshot · 서버의 request(스펙 §7 · §9)
// 전송을 모른다. 웹소켓 · SSE 의 겉이 연결 하나를 Conn 으로 맞춰 attach 로 넘기고, SSE 의 POST 는 handlePost 로 넘긴다
import { CLOSE, DEFAULTS, HEADER, TEXT, type ClientMessage, type Outcome, type ServerMessage } from "../stream/protocol.js";
import { helloFromHeaders, tokenOf } from "./sse.js";

/** 홉이 연결에 대해 아는 것 전부 — 전송의 겉이 이 꼴로 맞춘다
 *  - headers: 연결을 연 요청의 헤더, 이름은 소문자. SSE 는 이것이 곧 hello 다(Authorization · X-Supa-Channel · X-Supa-Epoch ·
 *    Last-Event-ID) — 그래서 SSE 는 onMessage 를 부르지 않아도 되고, 홉은 attach 하자마자 인증한다
 *  - close: 웹소켓은 닫기 코드로, SSE 는 close 메시지를 쓰고 응답을 끝낸다. SSE 에서 첫 send 전에 close 가 오면
 *    아직 응답 머리를 쓰지 않았으므로 HTTP 상태로 답한다 — 4001 → 401, 그 밖의 코드 → 503. 홉은 무엇을 보냈는지 모르므로
 *    이 판정은 전송의 겉(node · web)이 한다
 *  - onClose: 상대가 끊었을 때, 그리고 close 를 부른 뒤에 — 여러 번 불려도 된다 */
export interface Conn {
  send(m: ServerMessage): void;
  close(code: number, reason: string): void;
  onMessage(fn: (m: ClientMessage) => void): void;
  onClose(fn: () => void): void;
  kind: "ws" | "sse";
  headers: Record<string, string | undefined>;
}

export interface AuthCtx {
  /** 웹소켓은 hello.auth, SSE · POST 는 Authorization 헤더(Bearer 를 뗀 것) */
  token: string | undefined;
  /** 클라이언트가 청한 채널 — 웹소켓은 hello.channel, SSE · POST 는 X-Supa-Channel */
  channel: string | undefined;
  headers: Record<string, string | undefined>;
  /** 거절한다 — 연결은 4001 로, POST 는 401 로 닫힌다 */
  reject(reason: string): never;
}

export interface ConnCtx<Id> {
  identity: Id;
  channel: string;
  token: string | undefined;
  /** welcome.connection */
  connection: string;
  /** 클라이언트의 handlers 에 묻는다(§7.6) — 30초 안에 답이 없으면 응답 지연, 끊기면 명령 실패로 거절한다 */
  request(method: string, params?: unknown[]): Promise<unknown>;
}

export interface StreamServerOptions<V, C, Id> {
  authorize?: (ctx: AuthCtx) => Id | Promise<Id>;
  /** 기본은 클라이언트가 청한 채널, 없으면 "default" */
  channel?: (ctx: AuthCtx & { identity: Id }) => string;
  /** 동기 — 부르는 순간의 채널 버전이 그 값의 버전이다 */
  snapshot: (ctx: ConnCtx<Id>) => V;
  commands?: Record<string, (ctx: ConnCtx<Id>, ...args: any[]) => unknown>;
  history?: { count?: number; ms?: number };
}

/** SSE 의 POST — body 는 받은 글자 그대로(JSON 읽기도 홉이 한다) */
export interface PostReq {
  headers: Record<string, string | undefined>;
  body: string;
}
/** command 면 reply, ask 면 fate 의 배열, answer 면 204 */
export interface PostRes {
  status: number;
  body: unknown;
}

export interface StreamServer<V, C = V, Id = unknown> {
  publish(channel: string, change: C): void;
  attach(conn: Conn): void;
  handlePost(req: PostReq): Promise<PostRes>;
  close(): void;
}

type Reply = Extract<ServerMessage, { t: "reply" }>;
type Fate = Extract<ServerMessage, { t: "fate" }>;
type Posted = Extract<ClientMessage, { t: "command" | "ask" | "answer" }>;

class Rejection extends Error {}

/** 시험 전용 — 홉이 쥔 채널 이름을 꺼낸다. 하위 경로로 내보내지 않는다 */
export const INSPECT = Symbol("supa-store.inspect");

/** 답 기록 하나 — reply 가 없으면 아직 도는 중. 키는 신원과 요청 id 를 함께(keyOf) */
interface Ran {
  /** 시작한 때, 끝나면 끝난 때 — 쥐는 기간은 답을 낸 때부터 센다 */
  at: number;
  promise: Promise<Reply>;
  reply?: Reply;
}
interface Channel {
  name: string;
  version: number;
  history: Array<{ version: number; change: unknown; at: number }>;
  replies: Map<string, Ran>;
  sessions: Set<Session<any>>;
}
interface Session<Id> {
  id: string;
  conn: Conn;
  closed: boolean;
  helloTimer?: ReturnType<typeof setTimeout>;
  ping?: ReturnType<typeof setInterval>;
  requests: Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>;
  /** welcome 을 보낸 뒤에 선다 */
  live?: { channel: Channel; who: string; ctx: ConnCtx<Id> };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
// ponytail: 신원은 JSON 글자로 가른다 — 키 순서가 다른 객체는 다른 신원, JSON 으로 쓸 수 없는 신원(순환)은 던진다
const identityKey = (v: unknown) => JSON.stringify(v) ?? "undefined";
const keyOf = (who: string, id: string) => `${who}\n${id}`;
const isStr = (v: unknown) => v === undefined || typeof v === "string";
/** 보내기 전에 JSON 으로 써 본다 — BigInt · 순환 같은 값 하나가 전송의 겉에서 던져 프로세스를 죽이지 않게. 쓸 수 있으면 undefined
 *  ponytail: 보낼 때 한 번 더 쓰므로 두 번 직렬화한다. 큰 값이 잦아지면 쓴 글자를 Conn 으로 넘긴다 */
const unwritable = (what: string, v: unknown) => {
  try {
    JSON.stringify(v);
    return undefined;
  } catch (e) {
    return `${what} JSON 으로 쓸 수 없다: ${messageOf(e)}`;
  }
};

/** 밖에서 온 메시지의 꼴을 본다 — 홉이 그 칸을 믿고 쓰기 전에 */
function valid(m: unknown): m is ClientMessage {
  if (typeof m !== "object" || m === null) return false;
  const x = m as Record<string, unknown>;
  switch (x.t) {
    case "command":
      return typeof x.id === "string" && typeof x.name === "string" && Array.isArray(x.args);
    case "ask":
      return Array.isArray(x.ids) && x.ids.every((id) => typeof id === "string");
    case "answer":
      return typeof x.id === "string" && typeof x.ok === "boolean" && (x.ok || typeof x.error === "string");
    case "hello":
      return (
        isStr(x.channel) &&
        isStr(x.epoch) &&
        isStr(x.auth) &&
        (x.version === undefined || (Number.isInteger(x.version) && (x.version as number) >= 0))
      );
    case "pong":
      return true;
    default:
      return false;
  }
}

export function createStreamServer<V, C = V, Id = unknown>(o: StreamServerOptions<V, C, Id>): StreamServer<V, C, Id> {
  /** 홉이 뜰 때마다 새로 — 다시 뜬 홉의 버전을 앞 홉의 것과 섞지 않는다 */
  const epoch = crypto.randomUUID();
  const count = o.history?.count ?? DEFAULTS.historyCount;
  const ms = o.history?.ms ?? DEFAULTS.historyMs;
  const channels = new Map<string, Channel>();
  /** connection id → 붙은 연결(hello 전 것까지) */
  const sessions = new Map<string, Session<Id>>();
  /** close() 뒤 — 새 연결은 4000 으로 닫고 publish 는 하지 않는다 */
  let down = false;

  const chan = (name: string) => {
    let ch = channels.get(name);
    if (ch) return ch;
    // 새 채널을 지을 때마다 연결 없는 버전 0 채널을 훑는다 — 답 기록이 다 지나간 것은 지운다
    // ponytail: 짓기마다 O(채널 수). 채널이 아주 많아지면 타이머로 한 번씩 훑는다
    for (const c of channels.values())
      if (c.version === 0 && c.sessions.size === 0) {
        trim(c);
        forget(c);
      }
    channels.set(name, (ch = { name, version: 0, history: [], replies: new Map(), sessions: new Set() }));
    return ch;
  };
  /** 클라이언트가 지은 이름의 빈 채널이 쌓이지 않게 — 버전이 오른 채널은 기록이 버전을 지키므로 남긴다 */
  const forget = (ch: Channel) => {
    if (ch.version === 0 && ch.sessions.size === 0 && ch.replies.size === 0) channels.delete(ch.name);
  };

  /** 기록 · 답 기록을 count 개 또는 ms 가운데 짧은 쪽까지 앞에서 자른다. 도는 중인 명령은 남긴다 */
  const trim = (ch: Channel) => {
    const old = Date.now() - ms;
    const h = ch.history;
    while (h.length > count || (h[0] && h[0].at < old)) h.shift();
    for (const [id, r] of ch.replies) {
      if (ch.replies.size <= count && r.at >= old) break;
      if (r.reply) ch.replies.delete(id);
    }
  };

  const drop = (s: Session<Id>) => {
    if (s.closed) return;
    s.closed = true;
    clearTimeout(s.helloTimer);
    clearInterval(s.ping);
    sessions.delete(s.id);
    const ch = s.live?.channel;
    if (ch) {
      ch.sessions.delete(s);
      forget(ch);
    }
    for (const r of s.requests.values()) {
      clearTimeout(r.timer);
      r.reject(new Error(TEXT.commandFailed));
    }
    s.requests.clear();
  };
  const shut = (s: Session<Id>, code: number, reason: string) => {
    if (s.closed) return;
    s.conn.close(code, reason);
    drop(s);
  };

  const authCtx = (token: string | undefined, channel: string | undefined, headers: AuthCtx["headers"]): AuthCtx => ({
    token,
    channel,
    headers,
    reject: (reason) => {
      throw new Rejection(reason);
    },
  });
  /** 신원과 채널을 정한다 — 거절이면 Rejection 을 던진다 */
  const identify = async (a: AuthCtx) => {
    const identity = (await o.authorize?.(a)) as Id;
    const channel = o.channel ? o.channel({ ...a, identity }) : (a.channel ?? "default");
    return { identity, channel, key: identityKey(identity) };
  };

  const request = (s: Session<Id>, method: string, params: unknown[] = []) => {
    if (s.closed) return Promise.reject(new Error(TEXT.commandFailed));
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.requests.delete(id);
        reject(new Error(TEXT.timeout));
      }, DEFAULTS.timeoutMs);
      s.requests.set(id, { resolve, reject, timer });
      s.conn.send({ t: "request", id, method, params });
    });
  };

  /** hello(SSE 는 헤더)를 받아 인증하고 welcome 뒤 따라잡기 — 따라잡을 기록이 없으면 snapshot */
  const welcome = async (s: Session<Id>, hello: Extract<ClientMessage, { t: "hello" }>) => {
    let who: { identity: Id; channel: string; key: string };
    try {
      who = await identify(authCtx(hello.auth, hello.channel, s.conn.headers));
    } catch (e) {
      return shut(s, e instanceof Rejection ? CLOSE.GO_AWAY : CLOSE.COME_BACK, messageOf(e));
    }
    if (s.closed) return;
    const ch = chan(who.channel);
    const ctx: ConnCtx<Id> = {
      identity: who.identity,
      channel: who.channel,
      token: hello.auth,
      connection: s.id,
      request: (method, params) => request(s, method, params),
    };
    s.live = { channel: ch, who: who.key, ctx };
    ch.sessions.add(s);
    trim(ch);
    s.conn.send({ t: "welcome", epoch, version: ch.version, connection: s.id });
    // 같은 epoch 이고 그 뒤 첫 바뀜이 기록에 남아 있으면 빠진 것만
    const from = hello.epoch === epoch ? hello.version : undefined;
    const first = ch.history[0]?.version ?? ch.version + 1;
    if (from !== undefined && from <= ch.version && from + 1 >= first) {
      for (const h of ch.history) if (h.version > from) s.conn.send({ t: "change", version: h.version, change: h.change });
    } else {
      let value: V;
      try {
        value = o.snapshot(ctx);
        const bad = unwritable("snapshot 을", value);
        if (bad) throw new Error(bad);
      } catch (e) {
        // 그 연결만 닫는다 — 홉과 다른 연결은 산다
        return shut(s, CLOSE.COME_BACK, `snapshot 실패: ${messageOf(e)}`);
      }
      s.conn.send({ t: "snapshot", version: ch.version, value });
    }
    s.ping = setInterval(() => s.conn.send({ t: "ping" }), DEFAULTS.pingMs);
  };

  /** 명령을 돌린다 — 같은 id 가 답 기록에 있으면 돌리지 않고 그 답(또는 도는 중인 그 약속)을 준다 */
  const run = (s: Session<Id>, m: Extract<ClientMessage, { t: "command" }>): Promise<Reply> => {
    const live = s.live!;
    const ch = live.channel;
    trim(ch);
    // 다른 신원의 같은 id 는 다른 기록이다 — 남의 답을 받지도, 남의 명령을 막지도 않는다
    const key = keyOf(live.who, m.id);
    const had = ch.replies.get(key);
    if (had) return had.promise;
    // 원형의 이름(toString 등)은 명령이 아니다. 없는 명령은 답 기록에 남기지 않는다 — 아무 이름으로 기록을 쌓지 못하게
    if (!o.commands || !Object.hasOwn(o.commands, m.name))
      return Promise.resolve({ t: "reply", id: m.id, ok: false, error: `알 수 없는 명령: ${m.name}`, version: ch.version });
    const ran = { at: Date.now() } as Ran;
    ran.promise = (async () => {
      let out: Outcome;
      try {
        const result = await o.commands![m.name]!(live.ctx, ...m.args);
        const bad = unwritable("명령의 결과를", result);
        out = bad ? { ok: false, error: bad } : { ok: true, result };
      } catch (e) {
        out = { ok: false, error: messageOf(e) };
      }
      // 쥐는 기간은 답을 낸 때부터 — 오래 돈 명령이 끝나자마자 잘려 다시 돌지 않게
      // 뒤로 옮겨 trim 이 앞에서부터 at 차례로 자르게 한다
      ran.at = Date.now();
      ch.replies.delete(key);
      ch.replies.set(key, ran);
      // 답할 때의 버전 — 명령이 낸 바뀜이 이미 들어 있다
      return (ran.reply = { t: "reply", id: m.id, ...out, version: ch.version });
    })();
    ch.replies.set(key, ran);
    return ran.promise;
  };

  const fate = (ch: Channel, who: string, id: string): Fate => {
    const r = ch.replies.get(keyOf(who, id));
    if (!r) return { t: "fate", id, state: "unknown-id" };
    if (!r.reply) return { t: "fate", id, state: "running" };
    const { t: _, ...rest } = r.reply;
    return { t: "fate", state: "done", ...rest };
  };

  const answer = (s: Session<Id>, m: Extract<ClientMessage, { t: "answer" }>) => {
    const r = s.requests.get(m.id);
    if (!r) return; // 늦게 온 답은 버린다
    s.requests.delete(m.id);
    clearTimeout(r.timer);
    if (m.ok) r.resolve(m.result);
    else r.reject(new Error(m.error));
  };

  /** command · ask · answer — 웹소켓의 메시지와 SSE 의 POST 가 함께 쓴다 */
  const dispatch = async (s: Session<Id>, m: Posted): Promise<Reply | Fate[] | null> => {
    if (m.t === "command") return run(s, m);
    if (m.t === "ask") {
      const { channel, who } = s.live!;
      trim(channel);
      return m.ids.map((id) => fate(channel, who, id));
    }
    answer(s, m);
    return null;
  };

  const hop: StreamServer<V, C, Id> = {
    publish(name, change) {
      if (down) return;
      // 버전을 올리기 전에 본다 — 쓸 수 없는 바뀜이 기록에 남아 따라잡기마다 다시 터지지 않게 부른 쪽에 던진다
      const bad = unwritable("바뀜을", change);
      if (bad) throw new TypeError(bad);
      const ch = chan(name);
      const version = ++ch.version;
      ch.history.push({ version, change, at: Date.now() });
      trim(ch);
      for (const s of ch.sessions) s.conn.send({ t: "change", version, change });
    },

    attach(conn) {
      if (down) return conn.close(CLOSE.COME_BACK, "서버가 내려갔다");
      const s: Session<Id> = { id: crypto.randomUUID(), conn, closed: false, requests: new Map() };
      sessions.set(s.id, s);
      conn.onClose(() => drop(s));
      // SSE 는 GET 요청이 곧 hello 다
      if (conn.kind === "sse") return void welcome(s, helloFromHeaders(conn.headers));
      s.helloTimer = setTimeout(() => shut(s, CLOSE.COME_BACK, "hello 가 오지 않았다"), DEFAULTS.helloMs);
      let greeted = false;
      conn.onMessage((m) => {
        if (s.closed || !valid(m)) return;
        if (!greeted && m.t === "hello") {
          greeted = true;
          clearTimeout(s.helloTimer);
          return void welcome(s, m);
        }
        if (m.t === "hello" || m.t === "pong") return;
        // welcome 전의 command · ask 는 처리하지 않고 실패로 답한다 — 클라이언트가 영영 기다리지 않게
        if (!s.live) {
          if (m.t === "answer") return;
          for (const id of m.t === "command" ? [m.id] : m.ids)
            s.conn.send({ t: "reply", id, ok: false, error: TEXT.commandFailed, version: 0 });
          return;
        }
        void dispatch(s, m).then((out) => {
          if (s.closed || !out) return;
          for (const x of Array.isArray(out) ? out : [out]) s.conn.send(x);
        });
      });
    },

    async handlePost(req) {
      let m: unknown;
      try {
        m = JSON.parse(req.body);
      } catch {
        return { status: 400, body: "JSON 이 아니다" };
      }
      if (!valid(m) || m.t === "hello" || m.t === "pong") return { status: 400, body: "command · ask · answer 가 아니다" };
      const s = sessions.get(req.headers[HEADER.connection] ?? "");
      if (!s?.live) return { status: 404, body: "그 연결이 없다" };
      // POST 마다 다시 인증하고, 신원과 채널이 그 연결의 것과 같은지 본다
      let who: { identity: Id; channel: string; key: string };
      try {
        // 신원을 JSON 으로 쓸 수 없으면 identify 가 던진다 → 500
        who = await identify(authCtx(tokenOf(req.headers), req.headers[HEADER.channel] || undefined, req.headers));
      } catch (e) {
        return e instanceof Rejection ? { status: 401, body: e.message } : { status: 500, body: messageOf(e) };
      }
      if (s.closed) return { status: 404, body: "그 연결이 없다" };
      const live = s.live;
      if (who.key !== live.who || who.channel !== live.ctx.channel)
        return { status: 403, body: "그 연결의 신원 · 채널이 아니다" };
      const out = await dispatch(s, m);
      return out === null ? { status: 204, body: null } : { status: 200, body: out };
    },

    close() {
      down = true;
      for (const s of [...sessions.values()]) shut(s, CLOSE.COME_BACK, "서버가 내려간다");
      channels.clear();
    },
  };
  // 시험만 본다 — 지금 쥔 채널의 이름
  return Object.assign(hop, { [INSPECT]: () => [...channels.keys()] });
}
