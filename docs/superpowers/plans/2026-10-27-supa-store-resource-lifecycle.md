# 자원이 보지 않는 값을 다루는 법 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `createResource` 의 무효화가 화면이 보는 칸만 곧바로 다시 받고, 조건으로 칸을 고르고, 보지 않게 된 칸을 `release` 대로 놓는다.

**Architecture:** 화면이 보는 args 의 장부는 `src/refetch.ts` 의 `watched` 에 이미 있다. 이 장부가 「보기 시작함 · 그만 봄」을 `src/query.ts` 에 알리게 하고, `query.ts` 의 칸(`cells`)이 낡음 표시와 놓기 타이머를 든다.

**Tech Stack:** TypeScript 5.8, React 18/19, vitest 3(jsdom), `tools/codegen.cjs`(node --test).

**Spec:** `docs/superpowers/specs/2026-10-27-supa-store-resource-lifecycle-design.md`

## Global Constraints

- 무효화(`invalidate(...)`)가 고른 칸 가운데 화면이 보는 칸만 곧바로 다시 받는다. 보지 않는 칸은 값을 두고 낡음만 표시한다. `await` 는 곧바로 다시 받은 칸만 기다린다. 이 규칙은 옵션 없이 모든 자원에 걸린다.
- 낡은 칸: 화면이 그 args 를 다시 보기 시작하면 곧바로 다시 받는다(앞 값을 보이며 `isFetching`). `fetch(args)` 는 다시 받는다. `getData(args)` 는 쥔 값을 그대로 준다.
- `invalidate` 는 `(args: A) => boolean` 도 받는다. idle 이 아닌 칸마다 불러 참인 칸을 고른다. `getData` · `setData` · `fetch` 에는 조건 꼴을 더하지 않는다.
- 생성기는 query 의 args 를 함수 타입으로 짓지 못하게 막는다(배열 타입을 막는 자리와 같은 꼴: `"<파일>: 자원의 args 는 함수로 짓지 않는다 — 조건 무효화와 헷갈린다"`).
- `createResource(define, { release?: number | false })`. 마지막 화면이 빠지고 그 ms 뒤 칸을 `cells` 에서 지운다. 그사이 다시 보면 놓지 않는다. 놓을 때 진행 중 응답은 버린다. 놓은 뒤 다시 보면 `loading` 부터. 생략 · `false` 면 놓지 않는다(지금 동작).
- 화면이 아닌 읽기(`getData` · `fetch`)는 보는 것으로 세지 않는다. 화면이 한 번도 보지 않은 채 `fetch` 로 받은 칸은 받기가 끝난 때부터 `release` 를 센다.
- 버전은 올리지 않는다(아직 내지 않은 0.4.0 에 담는다). 주석은 짧은 한국어. 커밋 메시지 한국어, 끝 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. 같은 args 를 두 화면이 보다가 하나만 빠지면 놓지 않는다. (Task 2)
2. 낡은 칸을 화면이 다시 볼 때 이미 받는 중이면 요청을 둘 보내지 않는다. (Task 1)
3. `release` 타이머가 도는 중에 `invalidate` · `setData` 가 그 칸에 와도 놓기가 꼬이지 않는다. (Task 2)
4. 목록 꼴 `useStore(key, { args: [a, b] })` 에서도 칸마다 보는 것으로 센다. (Task 1)
5. `disposeStores` · `resetStores` 뒤 남은 놓기 타이머가 새 자원의 칸을 건드리지 않는다. (Task 2)

---

### Task 1: 보는 칸만 다시 받는 무효화와 조건 무효화

**Files:**
- Modify: `src/refetch.ts`(`watch` 가 보기 시작 · 그만 봄을 알릴 자리), `src/query.ts`(`invalidate` · `fetchOne` · 칸의 낡음), `src/resourceHook.ts`(필요하면), `tools/codegen.cjs`(함수 타입 args 막기)
- Test: `src/query.test.tsx`, `tools/codegen.test.mjs`

**Interfaces:**
- Produces: `createRefetcher` 의 core 에 `onWatch?(args)` · `onUnwatch?(args)`(첫 화면이 들어올 때 · 마지막 화면이 빠질 때) — Task 2 가 같은 두 자리를 쓴다. `Cache.invalidate(args?: A | readonly A[] | ((args: A) => boolean)): Promise<void>`.

- [ ] **Step 1: 시험을 쓴다**
  - 탭 a · b · c 를 차례로 보고(앞 화면은 내린다) c 만 남긴 뒤 `invalidate()`: query 는 c 로 한 번만 불린다. `await invalidate()` 는 c 의 받기만 기다린다. 그 뒤 b 를 다시 보면 그때 b 를 받고, 받는 동안 앞 값을 보이며 `isFetching` 이 참이다.
  - 낡은 칸: `getData(b)` 는 앞 값, `fetch(b)` 는 다시 받는다.
  - `invalidate((a) => a.repo === "A")`: A 의 칸만 고른다(보는 A 는 곧바로, 보지 않는 A 는 낡음). B 의 칸은 건드리지 않는다.
  - 목록 꼴 `{ args: [a, b] }` 를 보는 화면 하나: 무효화하면 a · b 둘 다 곧바로 다시 받는다(Review Focus 4).
  - 낡은 칸을 다시 볼 때 그 args 가 이미 받는 중이면 query 는 더 불리지 않는다(Review Focus 2).
  - 생성기: query 의 args 가 함수 타입이면 위 문구로 실패한다. 함수가 아닌 args 는 그대로 통과.
- [ ] **Step 2: 돌려 실패를 본다** — `pnpm vitest run src/query.test.tsx`, `node --test tools/codegen.test.mjs`
- [ ] **Step 3: 구현한다**
- [ ] **Step 4: 돌려 통과를 본다** — `pnpm test`, `pnpm typecheck`
- [ ] **Step 5: 커밋한다** — `feat(query): 무효화는 보는 칸만 곧바로 다시 받고 조건으로 칸을 고른다`

### Task 2: `release` — 보지 않게 된 칸을 놓는다

**Files:**
- Modify: `src/query.ts`(옵션 `release`, 놓기 타이머, 놓을 때 진행 중 응답 버림), `README.md`(자원 절에 셋 — 무효화 범위 · 조건 · release — 를 한 단락씩)
- Test: `src/query.test.tsx`

**Interfaces:**
- Consumes: Task 1 의 `onWatch` · `onUnwatch`

- [ ] **Step 1: 시험을 쓴다** (가짜 타이머)
  - `release: 0`: 화면이 내려가면 칸이 사라진다(`getData` 가 `undefined`). 다시 보면 `status: "loading"` 부터 받는다. 내려갈 때 받는 중이던 응답은 칸을 되살리지 않는다.
  - `release: 1000`: 999ms 안에 다시 보면 놓지 않고 앞 값을 보인다. 1000ms 가 지나면 놓는다.
  - 두 화면이 같은 args 를 보다가 하나만 내려가면 놓지 않는다(Review Focus 1).
  - 놓기 타이머가 도는 중에 그 칸에 `setData` · `invalidate` 가 와도 정한 때에 놓이고 던지지 않는다(Review Focus 3).
  - 화면 없이 `fetch(args)` 로 받은 칸은 받기가 끝난 뒤 `release` 가 지나면 놓인다.
  - `release` 를 주지 않으면 지금처럼 쥔다(기존 시험 전부).
  - `disposeStores()` 뒤 남은 타이머가 터져도 새로 지은 자원의 칸을 지우지 않는다(Review Focus 5).
- [ ] **Step 2: 돌려 실패를 본다**
- [ ] **Step 3: 구현하고 README 를 고친다**
- [ ] **Step 4: 돌려 통과를 본다** — `pnpm test`, `pnpm typecheck`, `pnpm test:pack`
- [ ] **Step 5: 커밋한다** — `feat(query): release — 보지 않게 된 칸을 놓는다`
