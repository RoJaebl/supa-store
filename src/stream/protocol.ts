// 연결의 약속(스펙 §7) — 메시지 갈래 · 닫기 코드 · 문구 · 기본 값. 서버의 홉과 화면의 클라이언트가 함께 쓴다
// 화면 쪽에서도 가져오므로 node · React 의 어느 것도 들이지 않는다

/** 명령 · 요청의 결과 — 성공이면 result, 실패면 앱의 문구 */
export type Outcome = { ok: true; result: unknown } | { ok: false; error: string };

export type ServerMessage =
  | { t: "welcome"; epoch: string; version: number; connection: string }
  | { t: "snapshot"; version: number; value: unknown }
  | { t: "change"; version: number; change: unknown }
  /** version 은 답할 때의 채널 버전 */
  | ({ t: "reply"; id: string; version: number } & Outcome)
  | ({ t: "fate"; id: string; state: "done"; version: number } & Outcome)
  | { t: "fate"; id: string; state: "unknown-id" | "running" }
  | { t: "request"; id: string; method: string; params: unknown[] }
  | { t: "ping" }
  /** SSE 에서 서버가 일부러 닫을 때 — 웹소켓은 닫기 코드로 */
  | { t: "close"; code: number; reason: string };

export type ClientMessage =
  /** epoch · version 은 가진 것이 있을 때, auth 는 웹소켓일 때 */
  | { t: "hello"; version?: number; epoch?: string; channel?: string; auth?: string }
  | { t: "command"; id: string; name: string; args: unknown[] }
  | { t: "ask"; ids: string[] }
  | ({ t: "answer"; id: string } & Outcome)
  | { t: "pong" };

/** 4001 은 「다시 오지 마라」, 4000 은 「곧 다시 와라」 */
export const CLOSE = { GO_AWAY: 4001, COME_BACK: 4000 } as const;

export const TEXT = {
  reconnecting: "연결 끊김. 재시도 중..",
  commandFailed: "연결 끊김. 명령 실패",
  unknown: "연결 끊김. 알 수 없음",
  timeout: "응답 지연",
} as const;

export const DEFAULTS = {
  historyCount: 1000,
  historyMs: 300_000,
  pingMs: 25_000,
  idleMs: 60_000,
  helloMs: 10_000,
  timeoutMs: 30_000,
  backoffStartMs: 1_000,
  backoffMaxMs: 30_000,
  jitter: 0.2,
} as const;

/** SSE 와 POST 가 싣는 헤더 — 이름은 소문자로 읽는다. 토큰은 Authorization 에만 싣는다(주소에 싣지 않는다) */
export const HEADER = {
  /** POST 가 어느 스트림 연결의 것인지 — welcome.connection */
  connection: "x-supa-connection",
  /** SSE 의 hello.channel */
  channel: "x-supa-channel",
  /** SSE 의 hello.epoch — 버전은 Last-Event-ID 가 싣는다 */
  epoch: "x-supa-epoch",
  lastEventId: "last-event-id",
  authorization: "authorization",
} as const;
