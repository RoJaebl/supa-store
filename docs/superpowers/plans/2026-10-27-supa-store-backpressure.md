# 읽지 않는 연결의 버퍼 쌓임 막기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 0.3 홉이 쌓인 바이트가 한도를 넘은 연결과 응답이 없는 웹소켓 연결을 4000 으로 닫는다.

**Architecture:** 홉(`src/server/core.ts`)이 연결마다 보내는 자리를 한 함수로 모아, 보내기 직전에 `conn.buffered()` 를 재고 웹소켓의 마지막 받은 때를 본다. 세 전송의 겉(`src/server/node.ts` · `web.ts`)은 `Conn.buffered()` 를 저마다 채운다.

**Tech Stack:** TypeScript 5.8 (NodeNext), Node 20+, `ws` 8, vitest 3.

**Spec:** `docs/superpowers/specs/2026-10-27-supa-store-backpressure-design.md`

## Global Constraints

- `createStreamServer` 옵션 `maxBuffered?: number`, 기본 `4 * 1024 * 1024`. `Infinity` 면 재지 않는다.
- 보내기 **직전에** 잰다: 이미 쌓인 양이 `maxBuffered` 를 넘었으면(`>`) 그 메시지를 보내지 않고 연결을 `CLOSE.COME_BACK`(4000) 으로 닫는다. 문구 `"버퍼가 넘쳤다"`.
- 웹소켓만: 마지막으로 무엇이든 받은 때(`pong` · 명령 · 답 · hello 모두)를 적고, `ping` 을 보낼 때 그로부터 `DEFAULTS.idleMs`(60_000) 가 지났으면 `ping` 대신 4000 으로 닫는다. 문구 `"응답이 없다"`. SSE 에는 걸지 않는다.
- `Conn` 에 `buffered(): number` 를 더한다(공개 타입이다 — 앱이 직접 지은 Conn 도 채워야 한다).
- 버전은 올리지 않는다(아직 내지 않은 0.4.0 에 담는다).
- 주석은 주변처럼 짧은 한국어. 커밋 메시지 한국어, 끝 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. 한도보다 큰 snapshot 하나: 앞이 비어 있으면 지나간다(닫히지 않는다). (Task 1)
2. 넘쳐 닫는 중에 같은 `publish` 의 다음 메시지가 그 연결로 또 가지 않는다 — 닫은 세션은 채널에서 빠진다. (Task 1)
3. 다시 이어 온 클라이언트는 새 세션이라 마지막 받은 때가 새로 시작한다. (Task 1)
4. ws 가 `bufferedAmount` 를 늘리지 않는 경우(닫힌 뒤) `buffered()` 가 던지지 않는다. (Task 2)
5. Web SSE 의 `buffered()` 는 읽는 쪽이 읽으면 줄어든다. (Task 2)

---

### Task 1: 홉 — 보내는 자리 하나, 넘침과 응답 없음

**Files:**
- Modify: `src/server/core.ts` (`Conn` 에 `buffered`, `StreamServerOptions` 에 `maxBuffered`, 보내는 자리 모으기, ping 판정)
- Modify: `src/server/node.ts`, `src/server/web.ts` — 이 Task 에서는 `buffered: () => 0` 만 채워 타입을 맞춘다(실제 값은 Task 2)
- Test: `src/server/core.test.ts`

**Interfaces:**
- Produces: `Conn.buffered(): number`; `StreamServerOptions.maxBuffered?: number`; 닫는 문구 `"버퍼가 넘쳤다"` · `"응답이 없다"`

- [ ] **Step 1: 시험을 쓴다** (`fakeConn` 에 `buffered` 값을 바꿀 수 있는 칸을 더한다)
  - `maxBuffered: 100` 에서 `buffered()` 가 101 인 연결에 `publish` 하면 그 메시지는 가지 않고 연결이 `4000` · `"버퍼가 넘쳤다"` 로 닫힌다. 같은 채널의 다른 연결은 받는다.
  - `buffered()` 가 0 이면 100 바이트보다 큰 snapshot 도 나가고 닫히지 않는다(Review Focus 1).
  - 넘쳐 닫힌 연결은 그 뒤 `publish` 를 더 받지 않는다(Review Focus 2).
  - 옵션을 주지 않으면 한도는 4 MiB 다: `buffered()` 가 `4 * 1024 * 1024` 이면 나가고, 그보다 1 크면 닫힌다. `Infinity` 면 아무리 커도 나간다.
  - 웹소켓: 가짜 타이머로 60초 동안 아무것도 받지 않으면 다음 ping 자리에서 `4000` · `"응답이 없다"` 로 닫힌다. 그 사이 `pong` 을 받으면 닫히지 않는다. 명령을 받아도 살아 있는 것으로 본다.
  - SSE 연결은 60초 넘게 아무것도 받지 않아도 닫히지 않는다.
  - 닫힌 연결을 다시 attach 하면(새 세션) 마지막 받은 때가 새로 시작한다(Review Focus 3).
- [ ] **Step 2: 돌려 실패를 본다** — `pnpm vitest run src/server/core.test.ts`
- [ ] **Step 3: 구현한다.** `conn.send` 를 부르는 모든 자리(welcome · history · snapshot · ping · publish · reply · request 와 그 밖)를 세션 하나를 받는 함수 하나로 모은다. 그 함수가 한도를 보고 넘었으면 `shut` 한다. ping 의 setInterval 콜백은 웹소켓이면 먼저 마지막 받은 때를 본다.
- [ ] **Step 4: 돌려 통과를 본다** — 그리고 `pnpm test` · `pnpm typecheck`
- [ ] **Step 5: 커밋한다** — `feat(server): 쌓인 버퍼 한도와 웹소켓 응답 없음을 4000 으로 닫는다`

### Task 2: 세 전송의 `buffered()` 와 설명

**Files:**
- Modify: `src/server/node.ts` (ws: `ws.bufferedAmount`, Node SSE: `res.writableLength`), `src/server/web.ts` (Web SSE: 응답 몸통을 `ByteLengthQueuingStrategy` 로 짓고 쌓인 바이트를 센다), `README.md`(「서버 정의」 근처에 `maxBuffered` 와 두 문구 한 단락), 0.3 설계 `docs/superpowers/specs/2026-10-25-supa-store-0.3-stream-design.md` §16 의 버퍼 쌓임 줄을 「막았다 — 2026-10-27 설계」로
- Test: `src/server/node.test.ts`, `src/server/web.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Conn.buffered(): number`, `maxBuffered`

- [ ] **Step 1: 시험을 쓴다**
  - Node SSE: 실제 http 서버에 붙고 응답을 읽지 않는(`res.pause()`) 클라이언트에 `maxBuffered` 작게(예 `64 * 1024`) 둔 채 큰 바뀜을 여러 번 `publish` 하면, 그 연결이 닫히고(`close` 메시지나 소켓 끝) 서버의 `buffered()` 가 한도 근처에서 멈춘다.
  - ws: 읽지 않는 클라이언트(`ws` 클라이언트의 소켓을 `pause()`)에 같은 꼴로 `publish` 하면 `4000` 으로 닫힌다. 닫힌 뒤 `buffered()` 를 불러도 던지지 않는다(Review Focus 4).
  - Web SSE: 몸통을 읽지 않으면 `buffered()` 가 쌓이고, 읽으면 줄어든다(Review Focus 5). 한도를 넘으면 닫힌다.
- [ ] **Step 2: 돌려 실패를 본다**
- [ ] **Step 3: 구현하고 README · 0.3 설계 §16 을 고친다**
- [ ] **Step 4: 돌려 통과를 본다** — `pnpm test` · `pnpm typecheck` · `pnpm test:pack`
- [ ] **Step 5: 커밋한다** — `feat(server): 세 전송이 쌓인 바이트를 잰다`
