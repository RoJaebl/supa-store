# supa-store 0.7.1 ofContext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ctx` 만 받는 정의 `createStore.ofContext((ctx) => …)` 를 더해, 그 꼴의 정의가 타입을 적지 않고도 추론되게 한다.

**Architecture:** `ofContext` 는 `createStore` 와 같은 모듈(`src/index.ts`)에 살고, `createStore((_set, _get, ctx) => creator(ctx))` 로 등록한다. 그래서 다시 짓기 · 듣기 떼기 · 이름 · 정의 파일 판정이 모두 0.7 장치를 그대로 탄다. 타입은 `(ctx: Ctx) => S` 하나라 `S` 가 돌려주는 값에서 추론된다.

**Tech Stack:** TypeScript 5.8, vitest 3(jsdom), node:test

**Spec:** `docs/superpowers/specs/2026-11-09-supa-store-of-context-design.md`

경로는 모두 supa-store 저장소 뿌리(워크트리 `C:/Users/hnpark/orca/workspaces/supa-store/of-context`) 기준이다.

## Global Constraints

- 더하는 공개 API 는 `createStore.ofContext<S extends object>(creator: (ctx: Ctx) => S): Store<S>` 하나다. 이름은 `ofContext`, 인자 이름은 `ctx`, 그 타입은 `Ctx`(`Ctx<S>` 가 아니다)
- `createStore` 의 시그니처 · 인자 차례 · 기본값 `never` 를 바꾸지 않는다
- `useStore` · `getStore` · `overrideStore` · `isDefinition` · Vite · Next 장치를 고치지 않는다
- 이름(부른 자리)은 `ofContext` 를 부른 파일의 `<경로>:<줄>` 이고, 배포 모드에서는 `#<n>` 이다
- 버전은 0.7.1 이다
- 문서 · 주석 · 오류 문구는 한국어 평서형(`-다`)으로 쓴다
- 커밋 메시지는 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 로 끝낸다

## Review Focus

- 서로를 `ctx` 로 가리키는 두 `ofContext` store 는 TypeScript 의 「자기 초기화에서 참조된다」 순환 추론에 걸린다. 변수에 `Store<…>` 를 적으면 지나가야 한다 — Task 1 의 타입 시험, Task 2 의 README 안내
- `ofContext` 를 함수 안에서 부르면 부를 때마다 새 store 다. `createStore` 와 같은 성질이라 막지 않고 README 의 「정의를 둘 때 지킬 것」에 함께 걸리게 한다 — Task 2
- `ofContext` 로 지은 파생(`createDerived`)이 기댄 store 를 따라 다시 계산해야 한다 — Task 1 의 동작 시험
- `overrideStore(ofContext 핸들, (set, get, ctx) => …)` 의 creator 가 일부 칸만 돌려줘도 된다(0.7 과 같다) — Task 1 의 시험
- `import { createStore as cs }` 로 바꿔 가져와 `cs.ofContext(…)` 만 쓰는 파일도 정의로 걸린다 — Task 1 의 판정 시험

---

### Task 1: `createStore.ofContext`

**Files:**
- Modify: `src/index.ts`(`createStore` 바로 뒤)
- Test: `src/ofContext.test.tsx`(새 파일), `tools/definition.test.mjs`(사례 더하기)

**Interfaces:**
- Produces: `createStore.ofContext<S extends object>(creator: (ctx: Ctx) => S): Store<S>`. `createStore` 의 타입은 호출 시그니처 하나(0.7 그대로)와 `ofContext` 칸을 가진다. 편집기의 정의로 가기가 `ofContext` 에서 듣는 꼴(함수 선언과 `namespace createStore` 병합, 또는 그에 준하는 꼴)을 고른다

- [ ] **Step 1: 실패하는 시험을 쓴다**

`src/ofContext.test.tsx` 에 아래를 박는다. `ev` 는 `createStore(() => createEvent<{ id: string }>())` 다.

```ts
it("자원의 타입이 정의에서 추론된다", () => {
  const todos = createStore.ofContext((ctx) => {
    ctx(ev).on(({ id }) => expectTypeOf(id).toEqualTypeOf<string>());
    return createResource(() => ({ query: async (a: { q: string }) => [a.q], add: async (t: string) => t }));
  });
  expectTypeOf(getStore(todos).getState().getData({ q: "x" })).toEqualTypeOf<string[] | undefined>();
});
it("파생이 기댄 store 를 따라 다시 계산한다", () => { /* createStore.ofContext((ctx) => createDerived(() => ctx(count).n * 2)) — count 를 바꾸면 값이 따라온다 */ });
it("ctx() 는 unknown 이다", () => { createStore.ofContext((ctx) => (expectTypeOf(ctx()).toEqualTypeOf<unknown>(), {})); });
it("useStore 의 pick · omit 이 고른 칸만 낸다", () => {
  const actions = createStore.ofContext((ctx) => ({ save: () => ctx(ev).emit({ id: "1" }), reset: () => {} }));
  const { result } = renderHook(() => useStore(actions, { omit: ["save"] }));
  expect(Object.keys(result.current)).toEqual(["reset"]);
  // @ts-expect-error 없는 이름
  renderHook(() => useStore(actions, { pick: ["nope"] }));
});
it("getStore 는 overrideStore · resetStores · disposeStores 뒤에도 같은 객체다", () => { … });
it("짓는 동안 건 on 이 overrideStore · resetStores · disposeStores 뒤에 하나만 남는다", () => { … emit 하나에 한 번 … });
it("ofContext store 에 ctx 로 기댄 store 는 그것을 overrideStore 하면 다시 지어진다", () => { … });
it("overrideStore 의 creator 는 세 인자 꼴이고 일부 칸만 돌려줘도 된다", () => {
  const actions = createStore.ofContext(() => ({ save: () => 1, reset: () => 2 }));
  overrideStore(actions, () => ({ save: () => 9 }));
  expect(getStore(actions).getState().save()).toBe(9);
});
it("서로를 가리키는 두 store 는 변수에 타입을 적으면 지나간다", () => {
  const a: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore.ofContext(() => ({ n: 1 }));
  expect(getStore(a).getState().n).toBe(1);
});
it("순환 오류의 이름이 이 시험 파일을 가리키고 index 를 가리키지 않는다", () => {
  const a: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(a).n }));
  expect(() => getStore(a).getState()).toThrow(/순환한다: .*ofContext\.test\.tsx:\d+ → .*ofContext\.test\.tsx:\d+/);
  expect(() => getStore(a).getState()).not.toThrow(/index\.(ts|js):/);
});
it("record() 의 who 가 이 시험 파일을 가리킨다", () => { … /ofContext\.test\.tsx:\d+$/ … });
it("배포 모드에서는 이름이 #<n> 이다", () => { … vi.stubEnv("NODE_ENV", "production") … /순환한다: #\d+ → #\d+/ … });
```

`…` 로 둔 본문은 `src/index.test.ts` · `src/query.test.tsx` 의 같은 뜻 시험을 `ofContext` 꼴로 옮겨 쓴다. 시험마다 새 event store 를 쓴다(공용 event 를 쓰면 `resetStores` 가 앞 시험의 store 를 다시 걸어 얽힌다 — 0.7 최종 수정에서 겪은 일이다).

`tools/definition.test.mjs` 에 더한다:

```js
test("createStore.ofContext 만 쓰는 파일도 정의다", () => {
  assert.equal(isDefinition(`import { createStore } from "supa-store";\nexport const x = createStore.ofContext((ctx) => ({}));`), true);
  assert.equal(isDefinition(`import { createStore as cs } from "supa-store";\nexport const x = cs.ofContext((ctx) => ({}));`), true);
});
```

- [ ] **Step 2: 실패를 본다**

Run: `pnpm vitest run src/ofContext.test.tsx`
Expected: FAIL — `createStore.ofContext` 가 없다(`definition.test.mjs` 의 사례는 지금도 통과해야 맞다: 판정을 고치지 않는다는 것을 박는 시험이다)

- [ ] **Step 3: `createStore.ofContext` 를 `src/index.ts` 에 짓는다**

`createStore((_set, _get, ctx) => creator(ctx as Ctx))` 를 부르고 그 핸들을 돌려준다. `createStore` 안에서 `new Error().stack` 을 만드는 자리는 그대로 두고, `ofContext` 가 같은 파일에 있어 `labelFromStack` 이 그 프레임도 건너뛰는지를 Step 1 의 이름 시험으로 확인한다. 건너뛰지 못하면 `labelFromStack` 을 고치지 말고 `ofContext` 쪽에서 해결한다(예: stack 을 만드는 자리를 두 함수가 함께 쓰는 안쪽 함수로 옮긴다). JSDoc 에 「`ctx` 만 쓰는 정의. `ctx()` 는 `unknown` 이니 자기 자신은 자기 핸들로 읽는다」를 적는다.

- [ ] **Step 4: 통과를 본다**

Run: `pnpm vitest run && pnpm typecheck && node --test tools/definition.test.mjs`
Expected: 모두 PASS, typecheck 오류 0

- [ ] **Step 5: 커밋**

```bash
git add src/index.ts src/ofContext.test.tsx tools/definition.test.mjs
git commit -m "feat: ctx 만 받는 정의 createStore.ofContext 를 더한다"
```

---

### Task 2: README · 묶음 시험 · 0.7.1

**Files:**
- Modify: `README.md`, `tools/pack.test.mjs`, `package.json`

**Interfaces:**
- Consumes: Task 1 의 `createStore.ofContext`

- [ ] **Step 1: 묶음 시험을 `ofContext` 꼴로 고친다**

`tools/pack.test.mjs` 의 `log` 정의(`createStore((set, _get, ctx) => …)` 를 변수 타입으로 적은 꼴)는 `set` 을 쓰므로 그대로 둔다. `ctx` 만 쓰는 정의를 하나 더한다: `export const title = createStore.ofContext((ctx) => ({ read: () => ctx(todo).getData()?.title }))`. `App.tsx` 에서 `useStore(title, { pick: ["read"] })` 를 부르게 해 `tsc -b && vite build` 가 이 꼴의 타입을 지나가는지 본다.

- [ ] **Step 2: README 를 고친다**

- 「정의와 꺼내기」의 자원 예시 가운데 `ctx` 를 쓰는 것을 `createStore.ofContext((ctx) => …)` 꼴로 바꾼다
- 「타입 인자를 적어야 하는 꼴」 절을 셋으로 다시 쓴다: 인자 없음은 추론된다 / `ctx` 만 쓰면 `createStore.ofContext` 를 쓴다(`ctx()` 는 `unknown`, 자기 자신은 자기 핸들로) / `set` · `get` 을 쓰면 반환 타입(`(set): Shape =>`)이나 `createStore<Shape>` 를 적는다. 지금 예시의 `total`(`createStore<Derived<number>>((_set, _get, ctx) => …)`)과 서로를 가리키는 `a` · `b` 를 `ofContext` 꼴로 바꾸고, `a` · `b` 는 변수에 `Store<…>` 를 적어야 한다는 안내를 남긴다
- 「0.7.0 의 `(_s: unknown, _g: unknown, ctx: Ctx) =>` 꼴도 그대로 통한다」를 한 줄 적는다
- 「정의를 둘 때 지킬 것」의 「모듈 최상단에서만 부른다」가 `createStore.ofContext` 에도 걸린다고 적는다
- 「0.7 에서 옮길 때」에 해당하는 짧은 절을 「0.6 에서 옮길 때」 위에 더한다: 깨지는 것은 없다, `ctx` 만 쓰는 정의를 `ofContext` 로 바꾸면 타입 인자를 지울 수 있다

- [ ] **Step 3: 버전을 올리고 전부 돌린다**

`package.json` 의 `"version"` 을 `"0.7.1"` 로.

Run: `pnpm test && pnpm typecheck && pnpm test:pack`
Expected: 모두 PASS. `test:pack` 은 네트워크가 필요하고 몇십 초 걸린다

- [ ] **Step 4: 커밋**

```bash
git add README.md tools/pack.test.mjs package.json
git commit -m "docs: ofContext 를 README 에 적고 0.7.1 로 올린다"
```
