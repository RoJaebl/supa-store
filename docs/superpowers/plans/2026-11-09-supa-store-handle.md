# supa-store 0.7 핸들 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** store 를 문자열 key 대신 `createStore(creator)` 가 돌려주는 핸들로 가리키게 하고, 생성기 · 설정 파일 · tsserver 플러그인 · CLI 를 걷는다.

**Architecture:** registry 는 등록 차례를 지키는 entry 목록이고, 핸들(얼린 빈 객체)에서 entry 로 가는 길은 `WeakMap` 하나다. 이름은 `createStore` 를 부른 자리의 stack 프레임에서 얻어 오류 문구와 event 기록에만 쓴다. Vite 플러그인과 Next 감싸기는 생성 대신, 정의 파일(또는 그것이 기대는 모듈)이 바뀌면 페이지 전체를 다시 읽게 하는 일만 한다.

**Tech Stack:** TypeScript 5.8, React 19, vitest 3(jsdom), node:test, Vite 8, Next(webpack)

**Spec:** `docs/superpowers/specs/2026-11-09-supa-store-handle-design.md`

경로는 모두 supa-store 저장소 뿌리(워크트리 `C:/Users/hnpark/orca/workspaces/supa-store/store-handle`) 기준이다.

## Global Constraints

- 버전은 **0.7.0** 이다. key API 와 핸들 API 를 함께 받는 중간 상태를 두지 않는다
- `createStore(creator)` 는 핸들 `Store<S>` 를 돌려준다. 핸들은 표지일 뿐이고 읽고 쓰는 메서드를 갖지 않는다
- React 밖에서 읽고 쓰는 길은 `getStore(handle)` 이고 0.6 의 `StoreApi<S>` 를 그대로 돌려준다. 다시 지어도 같은 객체다
- 이름으로 store 를 찾는 API 를 두지 않는다. 핸들에 이름을 내보이는 칸도 두지 않는다
- 이름 꼴: 개발 모드와 시험(`process.env.NODE_ENV !== "production"`)은 `<경로>:<줄>`, 배포 빌드와 읽지 못한 경우는 `#<n>`(등록 차례, 1부터). 늘 비어 있지 않다
- 0.6 의 개발 모드 재등록 갈래를 걷는다. `createStore` 는 언제나 새 entry 를 만든다
- `on(fn)` · `exempt(why)` 는 「누가」를 받지 않는다. 짓는 공간에서 부르면 지금 짓는 store 가 누구다. 짓는 공간 밖의 `exempt` 는 오류다
- 짓는 동안 건 듣기는 그 store 를 `dispose` 할 때 `[DISPOSE]` 를 부른 뒤 뗀다. `[DISPOSE]` 가 던져도 뗀다
- `ctx.key` · `StateTypes` · `StateKey` · `StateOf` · `PublicKey` · 닫힌 key · `registeredKeys` 를 걷는다
- 정의 파일 판정은 「파일이 `supa-store` 에서 `createStore` 를 가져오는가」이고, 페이지 다시 읽기 판정은 「바뀐 모듈이나 그것을 거슬러 import 한 모듈 가운데 정의 파일이 있는가」다
- 문서 · 주석 · 오류 문구는 한국어로 쓴다. 기존 파일의 말투(평서형 `-다`)를 따른다
- 커밋 메시지는 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 로 끝낸다

## Review Focus

- `import { createStore as cs } from "supa-store"` 처럼 이름을 바꿔 가져온 정의 파일도 정의로 알아봐야 한다. 놓치면 Fast Refresh 가 받아져 store 가 둘로 갈라진다 — Task 4 의 판정 시험
- 아직 옮기지 않은 코드가 `getStore("k")` 처럼 문자열을 넘기면 `undefined` 에서 터지지 않고 「store 핸들이 아니다」로 실패해야 한다 — Task 2 의 시험
- 짓는 공간 밖(동작 · 콜백 안)에서 `on(fn)` 을 두 번 부르면 두 듣기가 모두 돌고 라이브러리가 떼지 않으며, 돌려받은 풀기 함수로만 떨어져야 한다 — Task 3 의 시험
- 정의 파일과 컴포넌트가 함께 import 하는 util 을 고쳤을 때 페이지를 다시 읽어야 한다(거슬러 올라가는 판정) — Task 4 의 시험
- Windows 경로(`C:\a\b.ts:3:9`)와 Firefox 꼴(`fn@http://…`) stack 에서도 이름이 `/` 로 이어진 `<경로>:<줄>` 이어야 한다 — Task 1 의 시험

---

### Task 1: 부른 자리에서 이름 얻기

**Files:**
- Create: `src/label.ts`
- Test: `src/label.test.ts`

**Interfaces:**
- Produces: `export function labelFromStack(stack: string | undefined): string | null` — `new Error().stack` 을 받아, 첫 프레임(그 stack 을 만든 함수가 사는 파일)과 같은 파일의 프레임을 건너뛴 뒤 처음 나오는 프레임을 `<경로>:<줄>` 로 돌려준다. 가려내지 못하면 `null`

- [ ] **Step 1: 실패하는 시험을 쓴다**

`src/label.test.ts` 에 아래를 박는다. 각 stack 은 첫째 줄 `Error`, 둘째 줄이 라이브러리 프레임, 셋째 줄이 부른 자리다.

```ts
const at = (lib: string, caller: string) => `Error\n    at createStore (${lib})\n    at ${caller}`;
it("Vite 개발 서버의 주소와 ?t= 를 뗀다", () =>
  expect(labelFromStack(at("http://localhost:5173/node_modules/.vite/deps/supa-store.js?v=1a2b:120:9",
    "http://localhost:5173/src/app/a.action.ts?t=1731111111:12:5"))).toBe("src/app/a.action.ts:12"));
it("webpack-internal 과 (app-pages-browser) 를 뗀다", () =>
  expect(labelFromStack(at("webpack-internal:///(app-pages-browser)/./node_modules/supa-store/dist/index.js:200:3",
    "webpack-internal:///(app-pages-browser)/./src/b.state.ts:7:1"))).toBe("src/b.state.ts:7"));
it("file:// 를 떼고 Windows 역슬래시를 / 로 바꾼다", () => {
  expect(labelFromStack(at("file:///C:/x/dist/index.js:1:1", "file:///C:/x/src/c.ts:3:9"))).toBe("C:/x/src/c.ts:3");
  expect(labelFromStack(at("C:\\x\\dist\\index.js:1:1", "C:\\x\\src\\c.ts:3:9"))).toBe("C:/x/src/c.ts:3");
});
it("라이브러리 파일의 프레임이 여럿이어도 건너뛴다", () =>
  expect(labelFromStack("Error\n    at f (/lib/index.js:1:1)\n    at g (/lib/index.js:9:1)\n    at /app/d.ts:4:2")).toBe("/app/d.ts:4"));
it("Firefox 꼴(fn@url:line:col)도 읽는다", () =>
  expect(labelFromStack("createStore@http://h/lib.js:1:1\n@http://h/src/e.ts?t=9:5:1")).toBe("src/e.ts:5"));
it("읽지 못하면 null", () => {
  expect(labelFromStack(undefined)).toBeNull();
  expect(labelFromStack("Error")).toBeNull();
});
```

- [ ] **Step 2: 실패를 본다**

Run: `pnpm vitest run src/label.test.ts`
Expected: FAIL — `labelFromStack` 을 찾지 못한다

- [ ] **Step 3: `labelFromStack` 을 `src/label.ts` 에 짓는다**

V8 꼴(`at … (위치)` · `at 위치`)과 Firefox 꼴(`…@위치`)에서 위치를 뽑고, 위치 끝의 `:<줄>:<열>` 을 떼어 줄을 얻는다. 다듬기는 `http(s)://<host>/` · `webpack-internal:///` · `(app-pages-browser)/` 처럼 괄호로 싼 앞마디 · 앞의 `./` · `file:///` 와 `?` 뒤를 뗀 뒤 `\` 를 `/` 로 바꾼다. 「같은 파일」은 다듬은 경로로 견준다.

- [ ] **Step 4: 통과를 본다**

Run: `pnpm vitest run src/label.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/label.ts src/label.test.ts
git commit -m "feat: createStore 를 부른 자리에서 store 의 이름을 읽는다"
```

---

### Task 2: 핸들 API 와 기존 시험의 이관

이 과제가 key API 를 통째로 핸들로 바꾼다. 소스와 기존 시험이 함께 바뀌어야 컴파일되므로 하나로 묶는다. `ctx.key` 는 Task 3 까지 **임시로 그 store 의 이름(문자열)** 을 준다 — event 의 `on(who, fn)` 이 아직 문자열을 받기 때문이다.

**Files:**
- Modify: `src/index.ts`(거의 전부), `src/react.ts`(타입과 `getStore` 호출), `src/derived.ts` · `src/query.ts` 의 주석 예시
- Modify: `src/index.test.ts` · `src/react.test.tsx` · `src/derived.test.tsx` · `src/query.test.tsx` · `src/resourceHook.test.tsx` · `src/refetch.test.tsx` · `src/stream/hook.test.tsx` · `src/rpc/client.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `labelFromStack`
- Produces:
  ```ts
  declare const STATE: unique symbol;
  export interface Store<S> { readonly [STATE]?: S }               // 표지. 런타임에는 Object.freeze({})
  export interface Ctx<Self = unknown> {
    (): Self;
    <T>(store: Store<T>): ReadOf<T>;
    <T, N extends Names<T>, O extends PickOptions<T, N>>(store: Store<T>, options: O): Picked<T, O>;
    readonly key: string;                                         // Task 3 에서 걷는다
  }
  export function createStore<S extends object>(creator: (set: SetState<S>, get: GetState<S>, ctx: Ctx<S>) => S): Store<S>;
  export function getStore<S>(store: Store<S>): StoreApi<S>;
  export function overrideStore<S>(store: Store<S>, creator: (set: SetState<S>, get: GetState<S>, ctx: Ctx<S>) => S): void;
  export function registeredStores(): Store<unknown>[];            // 등록 차례
  export type Names<S> = keyof S & string;
  export type PickOptions<S, N extends Names<S> = Names<S>>;        // 0.6 과 같은 모양, key 대신 상태 타입
  export type Picked<S, O>;                                         // 같다
  /** @internal — query.ts 의 event 가 쓴다 */
  export function currentBuild(): { label: string; adopt(off: () => void): void } | undefined;
  ```
  `useStore` 의 겹치기 선언은 0.6 과 같은 다섯 갈래를 `Store<S>` 의 `S` 로 가린다(스트림 · 자원 · 그 밖의 `USE` · 전부 · `pick`/`omit`).

- [ ] **Step 1: `src/index.test.ts` 를 핸들 꼴로 옮기고 새 시험을 더한다**

`declare module` 보강을 지우고 모든 `createStore("k", …)` 를 `const k = createStore(…)` 로, `getStore("k")` 를 `getStore(k)` 로, `ctx("k")` 를 `ctx(k)` 로 바꾼다. 「registeredKeys 는 정렬된 key 목록이다」는 아래 첫 시험으로 바꾼다. 다음을 더한다.

```ts
it("registeredStores 는 등록한 차례대로 핸들을 준다", () => {
  const x = createStore(() => ({})); const y = createStore(() => ({}));
  const all = registeredStores();
  expect(all.indexOf(x)).toBeLessThan(all.indexOf(y));
});
it("getStore 는 핸들이 아니면 던진다", () => {
  expect(() => getStore("state.test.count" as never)).toThrow("store 핸들이 아니다");
});
it("같은 creator 로 두 번 부르면 서로 다른 store 다", () => {
  const make = () => ({ n: 0 });
  const p = createStore(make); const q = createStore(make);
  getStore(p).setState({ n: 1 });
  expect(getStore(q).getState().n).toBe(0);
});
it("순환 오류에 두 store 의 이름이 부른 자리 꼴로 선다", () => {
  const a: Store<{ n: number }> = createStore((_s, _g, ctx) => ({ n: ctx(b).n }));
  const b: Store<{ n: number }> = createStore((_s, _g, ctx) => ({ n: ctx(a).n }));
  expect(() => getStore(a).getState()).toThrow(/순환한다: .*index\.test\.ts:\d+ → .*index\.test\.ts:\d+ → .*index\.test\.ts:\d+/);
});
it("배포 모드에서는 이름이 #<n> 이다", () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    const a: Store<{ n: number }> = createStore((_s, _g, ctx) => ({ n: ctx(a).n }));
    expect(() => getStore(a).getState()).toThrow(/순환한다: #\d+ → #\d+/);
  } finally { vi.unstubAllEnvs(); }
});
it("getStore(handle) 은 overrideStore · resetStores · disposeStores 뒤에도 같은 객체이고 구독이 남는다", () => { … });
it("ctx(handle) 로 기댄 store 는 기댄 store 를 overrideStore 하면 다시 지어진다", () => { … });
```

뒤의 두 시험 본문은 0.6 의 같은 뜻 시험(같은 파일의 기존 시험)을 핸들 꼴로 옮겨 쓴다. 이미 있으면 더하지 않는다.

- [ ] **Step 2: 실패를 본다**

Run: `pnpm vitest run src/index.test.ts`
Expected: FAIL — `registeredStores` 가 없고 `createStore` 가 key 를 요구한다

- [ ] **Step 3: `src/index.ts` 를 핸들로 바꾼다**

- registry: `const entries: Entry[] = []` 와 `const entryOf = new WeakMap<object, Entry>()`. 찾지 못하면 `store 핸들이 아니다` 로 던진다.
- `Entry` 의 `key` 를 `label: string` 으로, `deps: Set<string>` 을 `Set<Entry>` 로, `building: string[]` 을 `Entry[]` 로 바꾼다. 순환 문구는 `순환한다: ${[...building, entry].map((e) => e.label).join(" → ")}` 이다.
- 이름: `process.env.NODE_ENV === "production"` 이면 `#${entries.length + 1}`, 아니면 `labelFromStack(new Error().stack) ?? #<n>`.
- `createStore` 는 언제나 새 entry 와 `Object.freeze({})` 핸들을 만든다. 같은 key 재등록 갈래와 그 오류를 지운다.
- `ctx(handle, options)` 는 0.6 의 `ctx(key, options)` 와 같은 일을 entry 로 한다. `ctx()` 는 그대로다. `ctx.key` 는 `entry.label`.
- `currentBuild()` 는 `building` 의 맨 끝 entry 가 있으면 `{ label, adopt }` 를 준다. `adopt(off)` 는 entry 의 `offs: (() => void)[]` 에 넣는다. `dispose()` 는 `[DISPOSE]` 를 부른 뒤(던지면 지금처럼 삼키고 적는다) `offs` 를 모두 부르고 비운다. 쓰는 쪽은 Task 3 이다.
- `rebuild` 는 key 대신 entry 를 받는다. `resetStores` · `disposeStores` 는 `entries` 를 돈다.
- `StateTypes` · `StateKey` · `StateOf` · `PublicKey` · `registeredKeys` 를 지우고, `Names` · `PickOptions` · `Picked` 를 상태 타입 꼴로 바꾼다.

- [ ] **Step 4: 통과를 본다**

Run: `pnpm vitest run src/index.test.ts`
Expected: PASS

- [ ] **Step 5: `src/react.ts` 와 나머지 시험을 옮긴다**

`useStore(store: Store<S>, …)` 로 겹치기 선언을 바꾸고 안에서 `getStore(store)` 를 부른다. `useRef` 캐시의 `key` 칸은 핸들을 담는다. 시험 파일 일곱의 `declare module` 보강을 지우고 핸들 꼴로 옮긴다. `react.test.tsx` 의 「_ 로 시작하는 key 는 useStore 로 꺼내지 못하고」 시험은 지운다(닫힌 key 를 걷는다). `resourceHook.test.tsx:631` 의 `ctx(ctx.key as never)` 는 그 store 자신의 핸들이나 `ctx()` 로 바꾼다. `@ts-expect-error` 시험은 핸들 꼴에서도 오류가 나도록 남긴다. `derived.ts` · `query.ts` 의 주석 예시를 핸들 꼴로 고친다.

- [ ] **Step 6: 시험과 타입 검사를 본다**

Run: `pnpm vitest run && pnpm typecheck`
Expected: vitest 전부 PASS, typecheck 오류 0. `tools/` 의 node 시험은 Task 6 까지 깨져 있어도 된다(생성기가 0.6 타입을 쓴다).

- [ ] **Step 7: 커밋**

```bash
git add src
git commit -m "feat!: store 를 key 대신 createStore 가 돌려주는 핸들로 가리킨다"
```

---

### Task 3: event 는 누가를 받지 않고, 짓는 동안 건 듣기는 버릴 때 뗀다

**Files:**
- Modify: `src/query.ts`(event 부분), `src/index.ts`(`ctx.key` 지우기)
- Test: `src/query.test.tsx`(event 시험), `src/index.test.ts`(`ctx.key` 시험 지우기)

**Interfaces:**
- Consumes: Task 2 의 `currentBuild()`
- Produces:
  ```ts
  export interface Event<P> {
    emit(payload: P): void;
    on(fn: (payload: P) => void): () => void;
    exempt(why: string): void;
    record(): { on: string[]; exempt: Array<{ who: string; why: string }> };  // who 는 이름, 둘 다 who 로 정렬
  }
  ```

- [ ] **Step 1: 실패하는 시험을 쓴다**

`query.test.tsx` 의 「같은 who 가 다시 on 하면 갈아 끼운다」를 지우고, 기존 event 시험을 `on(fn)` · `exempt(why)` 꼴로 옮긴 뒤 아래를 더한다. `ev` 는 `createStore(() => createEvent<number>())` 다.

```ts
it("짓는 동안 건 on 은 overrideStore · resetStores · disposeStores 뒤에도 하나만 돈다", () => {
  const seen: number[] = [];
  const r = createStore((_s, _g, ctx) => (ctx(ev).on((n) => seen.push(n)), {}));
  getStore(r).getState();
  overrideStore(r, (_s, _g, ctx) => (ctx(ev).on((n) => seen.push(n * 10)), {}));
  getStore(ev).getState().emit(1);          // ev 는 다시 지어지지 않았다 — 옛 r 의 듣기가 떨어졌어야 한다
  expect(seen).toEqual([10]);
  resetStores(); getStore(r).getState();
  disposeStores(); getStore(r).getState();
  getStore(ev).getState().emit(2);
  expect(seen).toEqual([10, 2]);
});
it("같은 store 가 짓는 동안 on 을 둘 걸면 둘 다 돈다", () => { … emit 하나에 두 처리기가 한 번씩 돈다 … });
it("[DISPOSE] 가 던져도 짓는 동안 건 듣기는 떨어진다", () => { … emit 뒤 seen 이 비어 있다 … });
it("짓는 공간 밖의 on 은 둘 다 돌고, 풀기 함수로만 떨어진다", () => {
  const seen: string[] = [];
  const event = getStore(ev).getState();
  const offA = event.on(() => seen.push("a"));
  event.on(() => seen.push("b"));
  event.emit(0);
  offA(); event.emit(0);
  expect(seen).toEqual(["a", "b", "b"]);
  expect(event.record().on).toEqual([]);
});
it("짓는 공간 밖의 exempt 는 던진다", () =>
  expect(() => getStore(ev).getState().exempt("까닭")).toThrow("exempt 는 store 를 짓는 동안에만 부른다"));
it("같은 store 가 on 과 exempt 를 함께 적으면 던진다(두 순서 모두)", () => { … });
it("record 의 who 는 부른 자리의 이름이다", () => {
  const r = createStore((_s, _g, ctx) => (ctx(ev).on(() => {}), {}));
  getStore(r).getState();
  expect(getStore(ev).getState().record().on).toEqual([expect.stringMatching(/query\.test\.tsx:\d+$/)]);
});
```

`resetStores` 가 event store 자신을 다시 지으면 새 event 객체가 서므로 그 앞의 듣기는 함께 사라진다. 0.6 과 같은 동작이고 이 과제는 바꾸지 않는다.

- [ ] **Step 2: 실패를 본다**

Run: `pnpm vitest run src/query.test.tsx`
Expected: FAIL — `on` 이 둘째 인자를 함수로 기대한다

- [ ] **Step 3: event 를 고친다**

`createEvent` 안의 처리기 표를 `{ who: string | null; fn }[]` 꼴로 바꾼다. `on(fn)` 은 `currentBuild()` 가 있으면 `who = label` 로 넣고 풀기 함수를 `adopt` 한다. `exempt(why)` 는 `currentBuild()` 가 없으면 `exempt 는 store 를 짓는 동안에만 부른다` 로 던진다. on/exempt 겹침 오류는 0.6 문구에서 who 자리만 이름으로 바꿔 쓴다. `record().on` 에는 who 가 있는 것만 넣는다. `src/index.ts` 에서 `ctx.key` 를 지우고 `index.test.ts` 의 「ctx.key 는 짓고 있는 store 의 key 다」와 `own: ctx.key` 를 지운다.

- [ ] **Step 4: 통과를 본다**

Run: `pnpm vitest run && pnpm typecheck`
Expected: 전부 PASS, 오류 0

- [ ] **Step 5: 커밋**

```bash
git add src
git commit -m "feat!: event 를 잇는 쪽은 이름을 적지 않고, 짓는 동안 건 듣기는 store 를 버릴 때 뗀다"
```

---

### Task 4: Vite 플러그인은 정의 파일이 바뀌면 페이지 전체를 다시 읽게 한다

**Files:**
- Create: `tools/definition.cjs`, `tools/definition.test.mjs`
- Modify: `tools/vite.mjs`(전부 다시 쓴다), `tools/vite.d.mts`
- Test: `tools/vite.test.mjs`(전부 다시 쓴다)

**Interfaces:**
- Produces: `tools/definition.cjs` 의 `isDefinition(code: string): boolean` — `supa-store` 에서 `createStore` 를 이름으로(바꿔 가져온 것 포함) 가져오면 참. Task 5 도 쓴다
- Produces: `supaStore(): import("vite").Plugin` — 인자 없음

- [ ] **Step 1: 판정 시험을 쓴다**

`tools/definition.test.mjs`(node:test):

```js
test("createStore 를 가져오면 정의다", () => {
  assert.equal(isDefinition(`import { createStore } from "supa-store";`), true);
  assert.equal(isDefinition(`import { USE, createStore as cs } from 'supa-store'`), true);
  assert.equal(isDefinition(`import {\n  createStore,\n} from "supa-store"`), true);
});
test("그 밖은 정의가 아니다", () => {
  assert.equal(isDefinition(`import { useStore } from "supa-store/react";`), false);
  assert.equal(isDefinition(`import { getStore } from "supa-store";`), false);
  assert.equal(isDefinition(`// createStore 는 supa-store 에서\nexport const x = 1`), false);
});
```

- [ ] **Step 2: 실패를 보고 `isDefinition` 을 짓고 통과를 본다**

Run: `node --test tools/definition.test.mjs`
Expected: 처음 FAIL(모듈 없음), 지은 뒤 PASS

- [ ] **Step 3: 플러그인 시험을 다시 쓴다**

`tools/vite.test.mjs` 를 생성 파일 시험 대신 아래로 바꾼다. 임시 폴더에 `createServer({ root, plugins: [supaStore()], server: { watch: … } })` 로 띄우고, client 환경의 `hot.send` 를 가로채 받은 것을 모은다. 각 시험은 모듈을 `transformRequest` 로 읽혀 모듈 그래프를 세운 뒤 파일을 고쳐 쓴다.

- `정의 파일을 고치면 full-reload 를 보낸다`
- `정의 파일이 import 하는 util 을 고치면 full-reload 를 보낸다` — `util.ts` 를 정의 파일과 컴포넌트가 함께 import 한다
- `정의와 무관한 컴포넌트를 고치면 full-reload 를 보내지 않는다`
- `빌드에서는 아무것도 하지 않는다` — `build()` 가 통과하고 생성 파일이 생기지 않는다
- `vitest 안에서는 아무것도 하지 않는다` — `process.env.VITEST` 를 세운 채 띄우면 정의 파일을 고쳐도 보내지 않는다

- [ ] **Step 4: 실패를 본다**

Run: `node --test tools/vite.test.mjs`
Expected: FAIL — full-reload 를 받지 못한다

- [ ] **Step 5: `tools/vite.mjs` 를 다시 쓴다**

`apply: "serve"`, `configResolved` 에서 `process.env.VITEST` 면 끈다. `hotUpdate` 훅(client 환경만)에서 바뀐 모듈들로부터 `importers` 를 거슬러 넓이 우선으로 돌며 각 모듈의 파일을 `isDefinition` 으로 본다(파일 읽기는 한 번의 갱신 안에서 캐시한다). 하나라도 참이면 `this.environment.hot.send({ type: "full-reload" })` 하고 `[]` 를 돌려준다. 생성 · 감시 · worker 코드와 `codegen.cjs` 의존을 지운다. `vite.d.mts` 는 `supaStore(): Plugin` 하나로 줄인다.

- [ ] **Step 6: 통과를 본다**

Run: `node --test tools/vite.test.mjs tools/definition.test.mjs`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add tools/definition.cjs tools/definition.test.mjs tools/vite.mjs tools/vite.d.mts tools/vite.test.mjs
git commit -m "feat!: Vite 플러그인은 정의 파일이 바뀌면 페이지 전체를 다시 읽게 한다"
```

---

### Task 5: Next 감싸기는 개발 모드에서 정의 파일의 갱신을 받지 않는다

**Files:**
- Create: `tools/decline-loader.cjs`
- Modify: `tools/next.mjs`(전부 다시 쓴다), `tools/next.d.mts`
- Test: `tools/next.test.mjs`(전부 다시 쓴다)

**Interfaces:**
- Consumes: Task 4 의 `isDefinition`
- Produces: `withStore(nextConfig: NextConfig): (phase: string) => NextConfig` — 0.6 과 같은 겉모양. `decline-loader.cjs` 는 webpack loader `(source: string) => string`

- [ ] **Step 1: 실패하는 시험을 쓴다**

- `loader 는 정의 파일 끝에 decline 을 덧붙이고 그 밖은 그대로 둔다` — 정의 파일 출력에 `import.meta.webpackHot.decline()` 이 들고, 아닌 파일은 입력과 같다
- `개발 모드의 브라우저 webpack 설정에만 loader 규칙이 선다` — `withStore({})("phase-development-server").webpack(config, { dev: true, isServer: false })` 의 `module.rules` 에 `decline-loader.cjs` 를 쓰는 규칙이 하나 서고 `node_modules` 를 뺀다. `dev: false` 나 `isServer: true` 면 서지 않는다
- `사용자의 webpack 함수를 먼저 부른다` — nextConfig 에 `webpack` 이 있으면 그 결과 위에 규칙을 더한다
- `개발 서버가 아닌 단계에서는 nextConfig 를 그대로 돌려준다`

- [ ] **Step 2: 실패를 본다**

Run: `node --test tools/next.test.mjs`
Expected: FAIL

- [ ] **Step 3: 짓는다**

loader 가 덧붙이는 줄은 `\nif (import.meta.webpackHot) import.meta.webpackHot.decline();\n` 이다. `next.mjs` 의 생성 · 감시 코드와 `codegen.cjs` 의존을 지운다. 정의 파일이 기대는 모듈을 고친 경우는 webpack 이 받지 않는 모듈에서 갱신을 멈추고 전체를 다시 읽으므로 따로 짓지 않는다(spec §3.6).

- [ ] **Step 4: 통과를 본다**

Run: `node --test tools/next.test.mjs`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add tools/decline-loader.cjs tools/next.mjs tools/next.d.mts tools/next.test.mjs
git commit -m "feat!: Next 감싸기는 개발 모드에서 정의 파일의 갱신을 받지 않는다"
```

---

### Task 6: 생성기를 걷고 묶음 · 문서 · 묶음 시험을 0.7 로 맞춘다

**Files:**
- Delete: `tools/codegen.cjs` · `codegen-worker.cjs` · `codegen.test.mjs` · `cli.mjs` · `cli.test.mjs` · `plugin.cjs` · `plugin.test.mjs` · `tsserver.test.mjs`, `plugin/`, `src/config.ts`
- Modify: `package.json`, `README.md`, `tools/pack.test.mjs`, `tsconfig*.json`(지운 파일을 가리키면)

- [ ] **Step 1: `tools/pack.test.mjs` 를 0.7 시작 절차로 고친다**

깨끗한 Vite 템플릿에 묶음을 설치하고 `supaStore()` 만 건다. `store-gen` · 생성 파일 · `plugin/index.js` 확인을 지운다. 정의는 `export const count = createStore((set) => ({ n: 1, inc: … }))`, 자원 · event 도 핸들 꼴로 쓰고, `App.tsx` 는 `useStore(count, { pick: ["n"] })` 로 꺼낸다. 확인은 둘이다: `tsc -b && vite build` 통과, 개발 서버가 `n=1` 을 그린다.

- [ ] **Step 2: 걷는다**

위 Delete 목록을 지운다. `package.json`: `"version": "0.7.0"`, `bin` 과 `exports` 의 `./config` · `./plugin` 을 지우고, `files` 에서 `plugin` 을 지운다. `peerDependencies` 의 `typescript` 는 `grep -rn "typescript" src tools --include=*.ts --include=*.mjs --include=*.cjs` 가 시험 밖에서 아무것도 찾지 않으면 meta 와 함께 지운다.

- [ ] **Step 3: README 를 고쳐 쓴다**

- 「정의와 꺼내기」 · 「세 공간」 · 「파생 store」 · 「자원 더 쓰기」 이하 모든 예시를 핸들 꼴로(`ctx(saved).on(fn)` 포함)
- 시작 절차: 생성 단계를 지우고 번들러 장치를 필수로 적는다. 걸지 않으면 정의 파일을 고친 뒤 갱신이 받아져 store 가 둘로 갈라질 수 있다고 한 줄로 밝힌다
- 「닫힌 key」 절은 「닫힌 store」로: export 하지 않거나 모듈 밖으로 다시 내보내지 않는다
- 「모듈 최상단에서만 `createStore` 를 부르고, 모듈 최상단에서 store 를 꺼내지 않는다」
- 「시험에서 정의를 바꾸려면 모듈을 다시 읽지 말고 `overrideStore` 를 쓴다」 · 「`record()` 를 견줄 때 이름을 문자열로 박지 않는다」
- 타입 추론이 안 되는 꼴에서는 `createStore<Shape>(…)` 로 적는다는 안내(Task 2 에서 실제로 적어야 했던 꼴을 예로)
- 「생성 파일」 · 「편집기에서 타입 따라오게 하기」 절을 지우고, 「Next.js 와 그 밖의 도구」는 `withStore` 와 「Turbopack 개발 서버에서는 정의 파일을 고친 뒤 직접 새로 고친다」로
- 「0.6 에서 옮길 때」 절을 spec §3.8 의 짝 목록대로 더한다

- [ ] **Step 4: 전부 돌린다**

Run: `pnpm install && pnpm test && pnpm test:pack`
Expected: 빌드 · vitest · node 시험 · 묶음 시험 모두 PASS. `pnpm test:pack` 은 네트워크가 필요하고 몇십 초 걸린다

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat!: 생성기 · 설정 파일 · tsserver 플러그인 · store-gen 을 걷고 0.7.0 으로 올린다"
```
