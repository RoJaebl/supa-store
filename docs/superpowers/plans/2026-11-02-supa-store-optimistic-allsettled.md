# supa-store 0.5 보완 — `optimistic` · 밀려남 · `onAllSettled` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 나중 호출의 성공만 앞 호출을 밀어내게 고치고, 겹 전용 칸 `optimistic` 과 모든 호출이 끝나면 한 번 도는 `onAllSettled` 를 더한다.

**Architecture:** 바뀌는 동작은 모두 `src/mutation.ts` 의 `createMutation` 안에 있다. `src/query.ts` 는 옵션 `onAllSettled` 를 이름별로 넘기기만 하고, `src/resourceHook.ts` 는 빈 상태 상수에 칸 하나를 더한다. 문서는 마지막 작업에서 한꺼번에 고친다.

**Tech Stack:** TypeScript, vitest(`expectTypeOf` 포함), React 18 `useSyncExternalStore`

**Spec:** `docs/superpowers/specs/2026-11-02-supa-store-optimistic-allsettled-design.md` (바탕: `docs/superpowers/specs/2026-10-30-supa-store-mutation-state-design.md`)

## Global Constraints

- 버전은 `package.json` 의 `0.5.0` 그대로 둔다.
- 새 의존성을 들이지 않는다.
- 겉 이름은 `optimistic` · `onAllSettled` 둘만 더한다. 호출 번호는 겉에 드러내지 않는다.
- `inflight` · `pending` 의 뜻은 바꾸지 않는다 — 보냈지만 응답이 오지 않은 호출.
- 콜백(`onSuccess` · `onError` · `onSettled` · `onAllSettled`)이 던지면 `console.error` 로 남기고 삼킨다.
- 커밋 메시지는 한국어이고 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 를 단다.
- 전체 검증: `pnpm test` 와 `pnpm typecheck` 가 통과한다. `pnpm test:pack` 은 이 작업 전부터 실패하므로 보지 않는다.

## Review Focus

1. **확인이 겹칠 때 앞 확인이 뒤 확인의 겹을 뺀다.** 확인 1 이 도는 동안 새 호출이 끝나 확인 2 가 시작되고, 확인 1 이 먼저 끝나면 그때도 `inflight` 는 비어 있다. 스펙의 「그때 `inflight` 가 비었으면」만 보면 확인 1 이 확인 2 의 겹을 빼 버린다. **가장 나중에 시작한 확인이 끝날 때만 뺀다** — Task 2 의 시험이 이것을 문다.
2. **`mutateAsync` 가 확인을 기다린다.** 확인을 호출의 Promise 사슬에 걸면 각 호출의 결과가 늦어진다. Task 2 의 시험이 문다.
3. **밀려난 호출의 실패가 `error` 를 적는다.** 나중 호출이 성공한 뒤 앞 호출이 실패로 오면 아무것도 적지 않아야 한다. Task 1 의 시험이 문다.
4. **같은 인자의 두 호출에서 밀려남이 엉뚱한 쪽을 뺀다.** `optimistic` 에서 빼는 단위는 인자가 아니라 호출 번호다. Task 1 의 시험이 문다.
5. **`reset` 뒤 밀려남.** `reset` 은 `data` · `error` 쓰기만 막는다. 밀려남과 `optimistic` 은 `reset` 과 상관없이 움직인다. Task 1 의 시험이 문다.

---

### Task 1: 밀려남과 `optimistic`

**Files:**
- Modify: `src/mutation.ts` (전체 — `MutationSnapshot`, `FIELDS`, `createMutation`)
- Modify: `src/resourceHook.ts:38` (`IDLE_MUTATION`), `src/resourceHook.ts:343` 근처 (연결 명령의 화면별 상태가 `inflight: []` 를 내주는 자리)
- Test: `src/mutation.test.ts`

**Interfaces:**
- Produces: `MutationSnapshot<F>` 에 `readonly optimistic: readonly Parameters<F>[]` 가 `inflight` 다음 자리에 선다. `FIELDS` 에 `"optimistic"` 이 들어가 읽기 전용 속성이 되고 `noteRead` 를 부른다. Task 2 가 같은 파일의 같은 자료(호출 목록)에 「확인을 기다린다」 표시를 더한다.

- [ ] **Step 1: 실패하는 시험을 쓴다**

`src/mutation.test.ts` 의 「늦은 응답은 …」 · 「늦은 실패도 …」 두 시험은 이름의 「늦은」을 「밀려난」으로 바꾸고 단언은 그대로 둔다(나중 호출이 성공한 경우라 새 규칙에서도 같다). 그리고 아래를 더한다. 파일 맨 위의 `controlled` 를 쓴다.

```ts
it("나중 호출이 성공하면 앞 호출은 그 순간 optimistic 에서 빠지고 inflight 에는 남는다", async () => {
  const { fn, calls } = controlled<number>();
  const m = createMutation(fn);
  const p1 = m.call(1);
  const p2 = m.call(2);
  expect(m.call.optimistic).toEqual([[1], [2]]);
  calls[1]!.resolve(20);
  await p2;
  expect(m.call.optimistic).toEqual([]);
  expect(m.call.inflight).toEqual([[1]]);
  calls[0]!.resolve(10);
  await expect(p1).resolves.toBe(10);
  expect(m.call.data).toBe(20);
});

it("나중 호출의 실패는 아무것도 밀어내지 않는다 — 앞 호출의 성공이 data 를 적고 onSuccess 를 부른다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const m = createMutation(fn, { onSuccess });
  const p1 = m.call(1);
  const p2 = m.call(2);
  calls[1]!.reject(new Error("green"));
  await expect(p2).rejects.toThrow("green");
  expect(m.call.error).toBe("green");
  expect(m.call.optimistic).toEqual([[1]]);
  calls[0]!.resolve(10);
  await p1;
  expect(m.call.data).toBe(10);
  expect(m.call.error).toBeNull();
  expect(onSuccess).toHaveBeenCalledWith(10, 1);
  expect(m.call.optimistic).toEqual([]);
});

it("같은 인자의 두 호출에서 나중 것이 성공하면 앞 것만 밀려난다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const m = createMutation(fn, { onSuccess });
  const p1 = m.call(1);
  const p2 = m.call(1);
  calls[1]!.resolve(2);
  await p2;
  calls[0]!.resolve(1);
  await p1;
  expect(onSuccess).toHaveBeenCalledTimes(1);
  expect(onSuccess).toHaveBeenCalledWith(2, 1);
  expect(m.call.data).toBe(2);
});

it("reset 뒤에도 나중 호출의 성공은 앞 호출을 밀어낸다", async () => {
  const { fn, calls } = controlled<number>();
  const onSuccess = vi.fn();
  const m = createMutation(fn, { onSuccess });
  const p1 = m.call(1);
  const p2 = m.call(2);
  m.call.reset();
  calls[1]!.resolve(20);
  await p2;
  expect(m.call.optimistic).toEqual([]);
  calls[0]!.resolve(10);
  await p1;
  expect(onSuccess).toHaveBeenCalledTimes(1);
  expect(m.call.data).toBeUndefined();
});
```

- [ ] **Step 2: 시험이 실패하는지 본다**

Run: `pnpm vitest run src/mutation.test.ts`
Expected: 새 네 시험이 FAIL — `optimistic` 이 `undefined` 이고, 둘째 시험은 `data` 가 `undefined` 다(지금은 나중 호출의 실패도 앞 응답을 버린다).

- [ ] **Step 3: `src/mutation.ts` 를 고친다**

- `done` 을 버리고 `won`(성공한 가장 큰 번호, 처음 0)을 둔다. 호출 n 은 `n < won` 이면 밀려났다.
- 응답이 오면: 밀려났으면 아무것도 적지 않고 콜백도 부르지 않는다. 아니면 지금처럼 `n > floor` 일 때 칸을 적고 콜백을 부른다. 성공이면 `won = n` 으로 올리고 `optimistic` 에서 `n` 보다 작은 번호를 모두 뺀다.
- `optimistic` 은 `calls` 와 따로 쥔 목록(번호와 인자)이다. 호출을 시작하면 두 목록에 함께 넣고, `finally` 에서 두 목록에서 함께 뺀다. 칸이 바뀔 때마다 새 배열로 갈아 끼운다.
- 맨 위 주석 두 곳(`done` · `floor` 설명, `createMutation` 설명)을 밀려남 규칙으로 고친다.
- `src/resourceHook.ts` 의 `IDLE_MUTATION` 과 연결 명령의 화면별 상태에 `optimistic: []` 를 더한다.

- [ ] **Step 4: 시험이 통과하는지 본다**

Run: `pnpm vitest run src/mutation.test.ts src/resourceHook.test.tsx src/query.test.tsx`
Expected: 모두 PASS

Run: `pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/mutation.ts src/mutation.test.ts src/resourceHook.ts
git commit -m "fix: 나중 호출이 성공했을 때만 앞 호출을 밀어내고, 겹은 밀려나지 않은 호출만 담는 optimistic 으로 얹는다"
```

---

### Task 2: `onAllSettled`

**Files:**
- Modify: `src/mutation.ts` (`MutationHooks`, `createMutation`)
- Modify: `src/query.ts:200-203` (옵션 타입), `src/query.ts:358-359` (`hooksOf`)
- Test: `src/mutation.test.ts`, `src/query.test.tsx`

**Interfaces:**
- Consumes: Task 1 의 `optimistic` 목록과 `won`.
- Produces: `MutationHooks<F>` 에 `onAllSettled?: () => unknown`. `createResource` 옵션에 `onAllSettled?: ByName<R, "onAllSettled">`.

- [ ] **Step 1: 실패하는 시험을 쓴다 — `src/mutation.test.ts`**

시험 이름과 단언만 적는다. 모두 `controlled` 를 쓰고, 확인은 `controlled` 의 약속처럼 시험이 푸는 Promise 를 돌려주는 `vi.fn` 이다.

- 「onAllSettled 를 적지 않으면 마지막 호출이 끝날 때 optimistic 이 빈다」 — 호출 하나를 성공시킨 뒤 `optimistic` 이 `[]`.
- 「inflight 가 빌 때마다 정확히 한 번 부른다 — 호출 하나여도, 마지막 호출이 실패해도」 — 호출 하나 성공 뒤 1회. 다시 호출 하나 실패 뒤 2회. 두 호출을 겹쳐 보내 둘 다 끝난 뒤 3회.
- 「확인이 끝나기 전에는 optimistic 이 남고 pending 은 false 다」 — 성공 뒤 `optimistic` 이 `[[1]]`, `pending` 이 `false`. 확인을 풀고 `await` 한 뒤 `optimistic` 이 `[]`.
- 「실패한 호출도 확인이 끝날 때까지 optimistic 에 남는다」 — 실패 뒤 `optimistic` 이 `[[1]]`, 확인을 푼 뒤 `[]`.
- 「확인을 기다리는 호출도 밀려난다」 — 확인이 도는 동안 새 호출 2 를 성공시키면 그 순간 `optimistic` 이 `[[2]]`.
- 「확인 중에 새 호출이 끝나면 확인을 한 번 더 하고, 앞 확인이 끝나도 겹은 남는다」 — 호출 1 성공(확인 1 시작), 호출 2 시작 후 성공(확인 2 시작). 확인 1 을 풀어도 `optimistic` 이 `[[2]]`. 확인 2 를 풀면 `[]`. 확인 함수는 2회 불렸다. **Review Focus 1.**
- 「mutateAsync 는 확인을 기다리지 않는다」 — 확인을 풀지 않은 채로 `await m.call(1)` 이 끝난다. **Review Focus 2.**
- 「확인이 던지거나 거부되면 콘솔에 남기고 optimistic 이 빈다」 — `console.error` 를 `vi.spyOn` 으로 막고, 동기로 던지는 경우와 거부되는 Promise 두 경우 모두 1회 남고 `optimistic` 이 `[]`.
- 「scope 와 함께 적어도 차례대로 나가고 마지막에 한 번 확인한다」 — 같은 `scope.id` 로 두 호출을 보내 차례대로 끝낸 뒤 확인 1회.

- [ ] **Step 2: 실패하는 시험을 쓴다 — `src/query.test.tsx`**

이 파일의 기존 `createResource` 시험 꼴을 따른다(받기 함수를 `vi.fn` 으로 두고 시험이 응답을 푼다).

- 「서버가 차례를 지키지 않아도 onAllSettled 의 다시 받기가 끝나면 서버 값이 된다」 — 스펙 §3 첫째 표를 재현한다. 받기는 처음 `"blue"`. `patch("red")`, `patch("green")` 을 보내고, `green` 을 먼저 `"green"` 으로, `red` 를 `"red"` 로 푼다. 자원은 `const r = createResource(def, { onSuccess: { patch: (v) => r.setData(v) }, onAllSettled: { patch: () => r.invalidate() } })` 처럼 자기 변수를 콜백에서 부른다 — 콜백은 만든 뒤에 돌기 때문이다. 다시 받기를 `"red"` 로 풀면 `getData()` 가 `"red"`, `patch.optimistic` 이 `[]`. 각 줄마다 `patch.inflight` · `patch.optimistic` · `getData()` 를 표의 값으로 단언한다.
- 「확인 응답은 확인 중에 성공한 새 호출의 setData 를 덮지 않는다」 — 확인의 다시 받기가 떠난 뒤 새 `patch("x")` 를 성공시켜 `getData()` 가 `"x"`. 그 뒤 앞 다시 받기를 `"old"` 로 풀어도 `getData()` 는 `"x"`.
- 「invalidate 의 다시 받기가 실패하면 optimistic 이 비고 실패는 받은 칸의 error 에 남는다」 — 다시 받기를 거부시킨 뒤 `patch.optimistic` 이 `[]`, 그 칸의 `error` 가 거부 문구, `console.error` 는 불리지 않았다.
- 타입 시험 — `expectTypeOf(resource.patch.optimistic).toEqualTypeOf<readonly [string][]>()`(바꾸기 함수가 `(v: string) => …` 일 때). 없는 바꾸기 이름 `onAllSettled: { nope: () => {} }` 은 `// @ts-expect-error`.

- [ ] **Step 3: 시험이 실패하는지 본다**

Run: `pnpm vitest run src/mutation.test.ts src/query.test.tsx`
Expected: 새 시험이 FAIL — `onAllSettled` 가 불리지 않고, 끝난 호출이 곧바로 `optimistic` 에서 빠진다.

- [ ] **Step 4: 구현한다**

`src/mutation.ts`:
- `MutationHooks` 에 `onAllSettled?: () => unknown` 를 더하고 한 줄 주석을 단다 — 「이 바꾸기의 inflight 가 빌 때마다 한 번 — 돌려준 Promise 가 끝날 때까지 끝난 호출을 optimistic 에 남긴다」.
- `onAllSettled` 가 있으면 `finally` 에서 그 호출을 `optimistic` 에서 빼지 않는다(밀려남은 Task 1 대로 바로 뺀다).
- `finally` 뒤 `calls` 가 비었고 `onAllSettled` 가 있으면 확인을 시작한다. 확인마다 번호를 매기고(`confirms`), `Promise.resolve().then(hooks.onAllSettled)` 를 `console.error` 로 받아 삼킨 뒤, **그 번호가 가장 나중 확인이고 그때 `calls` 가 비었을 때만** `optimistic` 을 `calls` 에 남은 것(곧 `[]`)으로 갈아 끼우고 알린다.
- 확인은 호출의 Promise 사슬 밖에서 돈다 — `call` 이 그것을 `await` 하지 않는다.

`src/query.ts`:
- 옵션 타입에 `onAllSettled?: ByName<R, "onAllSettled">;` 를 `scope` 앞에 더한다.
- `hooksOf` 가 `onAllSettled: onAllSettled?.[name]` 도 넘긴다.

- [ ] **Step 5: 시험이 통과하는지 본다**

Run: `pnpm vitest run src/mutation.test.ts src/query.test.tsx src/resourceHook.test.tsx`
Expected: 모두 PASS

Run: `pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/mutation.ts src/mutation.test.ts src/query.ts src/query.test.tsx
git commit -m "feat: 바꾸기의 inflight 가 빌 때마다 한 번 도는 onAllSettled 를 더하고, 그 확인이 끝날 때까지 겹을 남긴다"
```

---

### Task 3: 문서

**Files:**
- Modify: `README.md:26`, `README.md:124-177`, `README.md:239-241`, `README.md:288`
- Modify: `src/index.ts:38`
- Modify: `docs/superpowers/specs/2026-10-30-supa-store-mutation-state-design.md` (§2.4 · §3 · §8 머리에 한 줄씩)

- [ ] **Step 1: README 를 고친다**

- 26 줄: `"supa-store": "^0.4.0"` 을 `"supa-store": "^0.5.0"` 으로.
- 124 줄: 상태 칸 목록에 `optimistic`(겹에 얹을 호출들 — `inflight` 에서 밀려난 호출을 뺀 것, `onAllSettled` 를 적었으면 확인을 기다리는 호출을 더한 것)을 더한다.
- 126 · 143 · 162 줄: 겹 예시를 `inflight` 에서 `optimistic` 으로.
- 171 줄: 옵션 목록에 `onAllSettled: { [name]: () => … }` 를 더하고, 「늦은 응답이면」을 「밀려났으면」으로.
- 173 줄 「늦은 응답」 문단을 「밀려남」 문단으로 바꾼다 — 나중에 보낸 호출이 **성공**하면 앞 호출은 밀려나고, 실패는 아무것도 밀어내지 않는다. 서버가 받은 차례대로 처리하지 않을 수 있으면 `onAllSettled` 로 마지막에 한 번 다시 받거나 `scope` 로 줄을 세운다.
- 177 줄 함정: `invalidate()` 를 `onSuccess` 에서 기다리면 겹이 먼저 빠진다는 문장 뒤에, `onAllSettled` 에서 돌려주면 확인이 끝날 때까지 겹이 남는다는 것과 그 쓰는 모습(스펙 §3 의 코드)을 적는다.
- 239 · 241 · 288 줄: 「`inflight` 겹」을 「`optimistic` 겹」으로, 「늦은 응답」을 「밀려난 응답」으로. 241 줄에 `onAllSettled` 는 TanStack 에 없고 호출마다가 아니라 모든 호출이 끝났을 때 한 번 돈다는 것을 더한다.

- [ ] **Step 2: `src/index.ts:38` 주석을 고친다**

`/** creator 의 셋째 인자 — 다른 store 의 부르는 순간의 값을 꺼낸다. 인자 없이 부르면 자기 자신. select 안에서 바꾸기 상태를 읽으면 그 칸을 따라간다 */`

- [ ] **Step 3: 0.5 설계에 가리키는 줄을 단다**

§2.4 의 「동시에 보내는 것이 기본이다」 문단 앞, §3 「쓰는 모습」 제목 바로 아래, §8 「시험」 제목 바로 아래에 같은 한 줄을 넣는다. 본문은 고치지 않는다.

`> 2026-11-02 보완: 늦은 응답의 기준과 겹의 칸이 바뀌었다 — [보완 설계](./2026-11-02-supa-store-optimistic-allsettled-design.md) 가 이 절을 고친다.`

- [ ] **Step 4: 전체 검증**

Run: `pnpm test`
Expected: vitest 와 tools 시험이 모두 PASS

Run: `pnpm typecheck`
Expected: 오류 없음

Run: `grep -n "inflight.reduce\|늦은 응답\|0.4.0\|구독은 없다" README.md src/index.ts`
Expected: README 의 바뀐 점 기록(0.4 에서 넘어오는 사람을 위한 절)에 남기는 것 말고는 아무것도 찍히지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add README.md src/index.ts docs/superpowers/specs/2026-10-30-supa-store-mutation-state-design.md
git commit -m "docs: 겹은 optimistic 으로 얹고 밀려남과 onAllSettled 를 README 에 적는다"
```
