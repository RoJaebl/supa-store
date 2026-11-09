# supa-store

`createStore` 가 돌려주는 핸들로 store 를 가리키고 `useStore(handle)` 로 꺼내는 작은 상태 라이브러리. 런타임 의존이 없다.

## 설치

```sh
npm i supa-store
```

`react >=18`, `vite >=6`, `next >=14` 는 쓰는 것만 있으면 된다.

npm 판 대신 GitHub 의 커밋을 바로 쓸 수도 있다. 설치할 때 `prepare` 가 `dist/` 를 짓는다. pnpm 이면 그 빌드를 허락한다.

```jsonc
// package.json
"supa-store": "github:RoJaebl/supa-store#<커밋>"
```

```yaml
# pnpm-workspace.yaml — pnpm 11 은 git 의존의 빌드를 받아 온 주소째로 허락받는다(이름만으로는 막는다)
allowBuilds:
  "supa-store@https://codeload.github.com/RoJaebl/supa-store/tar.gz/<커밋>": true
```

커밋을 바꿀 때는 두 자리의 `<커밋>` 을 함께 바꾼다. npm 판이 나오면 `"supa-store": "^0.7.0"` 으로 바꾸고 `allowBuilds` 줄은 지운다.

## 시작 절차

**번들러 장치를 하나 건다. 이 단계는 필수다.** 생성 단계는 없다. 정의 파일은 그 핸들을 import 하는 순간 등록된다.

```ts
// vite.config.ts
import { supaStore } from "supa-store/vite";
export default defineConfig({ plugins: [react(), supaStore()] });
```

```js
// next.config.mjs — 객체든 (async) 함수든 그대로 감싼다
import { withStore } from "supa-store/next";
export default withStore({});
```

장치는 개발 서버에서 정의 파일(`supa-store` 에서 `createStore` 를 가져오는 파일)이나 정의 파일이 거슬러 기대는 모듈이 바뀌면 페이지 전체를 다시 읽게 한다. 빌드와 vitest 에서는 아무것도 하지 않는다. **걸지 않으면 정의 파일을 고친 뒤 갱신이 Fast Refresh 로 받아져, 정의 모듈이 다시 돌며 같은 store 가 옛것과 새것 둘로 갈라질 수 있다.** 컴포넌트나 presenter 를 고칠 때는 지금처럼 Fast Refresh 가 돈다.

## 정의와 꺼내기

`createStore` 는 store 를 등록하고 그것을 가리키는 핸들을 돌려준다. 핸들을 export 하고, 꺼내는 쪽이 그것을 import 한다. 파일 이름은 자유다.

```ts
// src/count.ts
import { createStore } from "supa-store";

type Count = { n: number; inc: () => void };
export const count = createStore<Count>((set) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));
```

```tsx
// 컴포넌트 — pick 으로 고른 칸이 바뀔 때만 다시 그린다
import { useStore } from "supa-store/react";
import { count } from "./count";
const { n, inc } = useStore(count, { pick: ["n", "inc"] });
```

React 밖에서는 `getStore(handle)` 로 읽고 쓴다. `getState` · `getInitialState` · `setState` · `subscribe` 를 갖고, 다시 지어도(`overrideStore` · `resetStores` · `disposeStores` 뒤) 같은 객체다. 핸들 자체는 store 를 가리키는 표지일 뿐 읽고 쓰는 메서드가 없다.

```ts
import { getStore } from "supa-store";
getStore(count).getState().inc();
```

서버에서 받아 오는 값은 자원으로, store 사이의 알림은 event 로 정의한다.

```ts
import { createStore } from "supa-store";
import { createEvent, createResource } from "supa-store/query";

export const todos = createStore(() =>
  createResource(() => ({
    query: async () => (await fetch("/api/todos")).json() as Promise<string[]>,
    add: async (title: string) => void (await fetch("/api/todos", { method: "POST", body: title })),
  })),
);
// useStore(todos) → { data, status, error, refetch, add: { mutate, mutateAsync, pending, error, data, reset } }

export const saved = createStore(() => createEvent<{ id: string }>());
```

### 타입 인자를 적어야 하는 꼴

**creator 가 받는 인자에 따라 세 꼴로 나뉜다.** `createStore` 의 creator 가 인자를 하나라도 받으면(쓰지 않는 `_set` 하나라도) 상태 타입이 추론되지 않는다. TypeScript 가 매개변수의 타입을 정하려고 상태 타입을 먼저 굳히는데, 그 자리에서 `never` 로 굳어 컴파일 오류가 난다.

| creator 가 쓰는 인자 | 이렇게 정의한다 | 타입은 |
|---|---|---|
| 없다 | `createStore(() => …)` | 돌려주는 값에서 추론된다 |
| `ctx` 만 | `createStore.ofContext((ctx) => …)` | 돌려주는 값에서 추론된다 |
| `set` · `get`(과 `ctx`) | `createStore((set): Shape => …)` 또는 `createStore<Shape>((set) => …)` | 적어 준 `Shape` 다 |

```ts
import { createStore, type Store } from "supa-store";
import { createDerived, createEvent, createResource } from "supa-store/query";

// 인자 없는 creator
export const todos = createStore(() => createResource(() => ({ query: fetchTodos })));
export const saved = createStore(() => createEvent<{ id: string }>());

// ctx 만 쓰는 creator — 자원 · 파생 · 다른 store 를 잇는 동작
export const todo = createStore.ofContext((ctx) => {
  ctx(saved).on(({ id }) => void id); // id: string
  return createResource(() => ({ query: fetchTodo }));
});
export const total = createStore.ofContext((ctx) => createDerived(() => ctx(count).n * 2)); // Store<Derived<number>>

// set · get 을 쓰는 creator — 모양을 적는다(반환 타입이나 타입 인자)
type Count = { n: number; inc: () => void };
export const count = createStore((set): Count => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));
export const last = createStore<{ id: string }>((set, _get, ctx) => {
  ctx(saved).on(({ id }) => set({ id }));
  return { id: "" };
});

// 서로를 가리키는 두 store 는 변수에 적어야 한다 — 적지 않으면 「자기 초기화에서 참조된다」 순환 추론에 걸린다
export const a: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(b).n }));
export const b: Store<{ n: number }> = createStore.ofContext((ctx) => ({ n: ctx(a).n }));
```

- **`ofContext` 의 `ctx()`(자기 자신 읽기)는 `unknown` 이다.** 자기 타입을 creator 의 인자에 넣으면 추론이 다시 깨지기 때문이다. 콜백(`onSuccess` 같은 것) 안에서는 자기 핸들로 `ctx(todo)` 처럼 읽으면 된다. **자원의 `select` 처럼 돌려주는 값이 자기 자신을 읽는 자리는 자기 핸들로도 안 된다** — 상태 타입이 자기에게 기대는 순환이 되어 추론이 깨진다. 그런 store 는 `ofContext` 가 아니라 타입을 적는 꼴(`createStore<Resource<…>>((_set, _get, ctx) => …)`)로 정의한다. 아래 「바꾸기」의 `appearance` 가 그 예다.
- `ofContext` 는 `createStore((_set, _get, ctx) => creator(ctx))` 와 같다. 다시 짓기 · 짓는 동안 건 듣기 · `overrideStore` · `useStore` 의 pick · omit · 이름이 모두 `createStore` 로 지은 store 와 같다. `overrideStore` 의 creator 는 `ofContext` 로 지은 store 에도 세 인자 꼴(`(set, get, ctx) => …`)이다.
- 0.7.0 에서 쓰던 `createStore((_s: unknown, _g: unknown, ctx: Ctx) => …)` 꼴도 그대로 추론된다. 고칠 필요는 없다.
- 타입 인자로 적을 때 자원 · 스트림 · 파생은 `Resource<A, D, R>`(`supa-store/query`) · `Stream<V, Cmd>`(`supa-store/stream`) · `Derived<T>`(`supa-store`) 다. `R` 은 자원에 정의한 객체의 타입이다(바꾸기 함수 칸만 본다). `ctx` 만 쓰면 `ofContext` 가 이것을 대신 추론한다.
- **오류 문구에 `never` 가 보이면 타입 인자를 적거나, `ctx` 만 쓰면 `ofContext` 로 바꾼다.** 인자를 받는 creator 에 타입 인자를 빠뜨리면 상태가 `never` 로 굳어, creator 가 돌려주는 객체가 `never` 에 맞지 않는다는 오류가 난다(`Type '{ … }' is not assignable to type 'never'`). 상태가 정말 비어 있으면 `createStore<{}>(…)` 로 적는다.

## 세 공간

**최신 값이 필요하면 클로저 안에서 `ctx` 로 읽는다.** 정의 안의 코드는 세 공간 가운데 하나에서 돈다.

- **짓는 공간** — 정의 함수의 본문. store 를 처음 꺼낼 때 한 번 돌아 인스턴스된 값을 짓는다. 여기서 읽은 값은 다시 지을 때까지 그대로이므로, 이 자리에서는 event 를 잇기만 한다(`ctx(saved).on(fn)`). 여기서 건 듣기는 지금 짓는 store 의 것이 되고, 그 store 를 버릴 때(`overrideStore` · `resetStores` · `disposeStores` 의 다시 짓기) 라이브러리가 뗀다. 그래서 다시 지어도 듣기가 겹치지 않는다. 일부러 듣지 않는다는 결정은 `ctx(saved).exempt("까닭")` 으로 남긴다.
- **동작 · 콜백** — 바꾸기 함수 · `onSuccess` · event 를 받는 함수. 불릴 때 돌고, 그 안의 `ctx` 는 부를 때마다 그 순간을 읽는다.
- **계산 공간** — `createDerived` 의 계산 함수와 자원 `select`. 그 안에서 `ctx(handle)` 로 읽은 store, `ctx(handle).getData(args)` 로 읽은 자원 칸, 바꾸기 상태가 바뀌면 라이브러리가 다시 부른다. 어느 store 의 `ctx` 로 읽었는지는 가리지 않는다 — 계산 중에 다른 store 의 함수가 자기 `ctx` 로 읽은 것도 입력이다.

짓는 공간 밖(React 밖의 코드 같은 곳)에서 `getStore(saved).getState().on(fn)` 으로 건 듣기는 누구의 것도 아니다. 풀기 함수를 돌려주고, 라이브러리가 떼지 않는다. `exempt` 는 짓는 공간 밖에서 부르면 `exempt 는 store 를 짓는 동안에만 부른다` 로 실패한다. `on` 과 `exempt` 를 같은 store 가 같은 event 에 함께 적으면 오류다.

`record()`(event 의 상태에 있다)는 그 event 를 누가 듣고 누가 일부러 듣지 않는지를 `{ on: string[]; exempt: { who; why }[] }` 로 준다. 이름은 아래 「store 의 이름」 절의 꼴이다.

## 파생 store

다른 store 를 읽어 값을 짓는 store 는 `createDerived` 로 정의한다. 계산 함수는 계산 공간에서 돈다.

```ts
import { createStore } from "supa-store";
import { createDerived } from "supa-store/query";

export const cartTotal = createStore.ofContext((ctx) =>
  createDerived(() => ctx(cart).items.reduce((sum, item) => sum + item.price * ctx(rate).value, 0)),
);

// 자원 칸을 읽는다 — 받는 동안에는 앞 결과(prev)를 잇는다
export const todoTitle = createStore.ofContext((ctx) =>
  createDerived((prev?: string) => ctx(todo).getData({ id: ctx(todoPick).id })?.title ?? prev ?? ""),
);
```

```tsx
const total = useStore(cartTotal); // 값 그대로
getStore(cartTotal).getState().get(); // React 밖
```

- 읽은 것이 바뀌면 다시 계산하고, 결과가 `Object.is` 로 앞과 같으면 구독자를 깨우지 않는다.
- 구독자가 없으면 따라가지 않는다. 꺼낼 때 읽은 것을 견주어 바뀌었으면 그 자리에서 다시 짓는다.
- 자원 칸을 읽으면 구독자가 있는 동안 그 칸을 보는 것으로 친다 — 비어 있으면 받고, `refetchInterval` · `release` 가 화면이 볼 때처럼 돈다.
- 다른 정의의 계산 공간에서 `ctx(파생 핸들)` 로 읽으면 값을 주고 따라간다. 파생이 파생을 읽을 수 있다.

## 닫힌 store

화면에 열지 않을 store 는 핸들을 export 하지 않거나, 그 모듈 밖으로 다시 내보내지 않는다. 핸들이 없으면 `useStore` 도 `ctx` 도 그 store 에 닿지 못한다. 어디까지 열지는 import 경계가 정한다. 원본 자원을 닫아 두고 파생만 화면에 여는 데 쓴다.

```ts
// todo.ts — raw 는 export 하지 않는다
const raw = createStore(() => createResource(() => ({ query: fetchRaw })));
export const view = createStore.ofContext((ctx) => createDerived(() => shape(ctx(raw).getData())));
```

## 정의를 둘 때 지킬 것

- **모듈 최상단에서만 `createStore` 와 `createStore.ofContext` 를 부른다.** 부를 때마다 새 store 가 생긴다. 함수나 컴포넌트 안에서 부르면 부를 때마다 store 가 늘어난다. 라이브러리는 이것을 막지 않는다.
- **모듈 최상단에서 store 를 꺼내지 않는다.** 최상단의 `getStore(x).getState()` 는 import 순환 안에서 아직 평가되지 않은 핸들을 만날 수 있다. 정의 파일끼리 서로 import 하는 것은 괜찮다. creator 는 처음 꺼낼 때 돌고, 그때는 두 모듈이 모두 평가를 마쳤다.
- **creator 안에서 다른 store 는 `ctx` 로 읽는다.** `getStore(x)` 로 읽으면 기댐이 적히지 않아 `x` 를 `overrideStore` 해도 다시 지어지지 않고, 파생은 다시 계산하지 않아 오류 없이 낡은 값을 낸다.
- **시험에서 정의를 바꾸려면 모듈을 다시 읽지 말고 `overrideStore(handle, creator)` 를 쓴다.** `vi.resetModules()` 뒤에 정의 파일을 다시 import 하면 새 store 가 따로 생기고, 옛 store 와 그것이 event 에 건 듣기가 남는다. 덮어쓴 정의는 `resetStores()` 가 지운다.

## store 의 이름

store 에 사람이 붙이는 이름은 없다. 오류 문구와 `record()` 에는 `createStore` 를 부른 자리가 이름으로 선다. 개발 모드와 시험에서는 `<경로>:<줄>`(예: `src/todo.ts:12`), 배포 빌드와 자리를 읽지 못한 경우는 등록 차례 `#<n>` 이다.

- 이 이름으로 store 를 찾는 API 는 없다. 핸들에도 이름 칸이 없다.
- **`record()` 를 견줄 때 이름을 문자열로 박지 않는다.** 줄 번호는 그 파일을 고치면 바뀐다. 수(`record().on.length`)나 포함 여부(`expect.stringContaining("todo.ts")`)로 견준다.
- `registeredStores()` 는 등록한 핸들을 등록한 차례대로 준다. 다시 이어졌을 때 모든 자원을 낡게 하는 것처럼 앱 전체에 거는 일에 쓴다. 어느 한 store 를 골라내는 길이 아니다.

## 자원 더 쓰기

아래 예는 이 자원을 쓴다. 자원 정의의 둘째 인자에는 `auto` · `select` · `placeholderData` · `refetchInterval` 을 적는다. 뒤의 셋은 화면 옵션에도 같은 이름으로 있다.

다시 받은 응답이 앞 값과 내용이 같으면 자원은 앞 객체를 그대로 둔다(보통 객체와 배열만 깊이 견준다). 같은 응답을 다시 받아도 그것을 읽는 화면과 파생이 깨지 않는다.

```ts
export const dirLevel = createStore(() =>
  createResource(() => ({
    query: async (a: { repo: string; dir: string }) => (await fetch(`/api/${a.repo}/${a.dir}`)).json() as Promise<string[]>,
    save: async (name: string) => name.length,
  })),
);
```

### 여러 args 를 한 번에

`args` 에 값 하나를 주면 하나, 배열을 주면 같은 순서의 배열을 돌려준다. 목록으로 꺼낸 화면과 하나로 꺼낸 화면은 같은 값과 같은 요청을 나눠 갖는다.

```tsx
const one = useStore(dirLevel, { args: { repo, dir } });
const many = useStore(dirLevel, { args: dirs.map((dir) => ({ repo, dir })), pick: ["data", "status"] });
// many: { data, status }[] — 목록의 pick · omit 은 조회 칸(data · status · error · isPlaceholderData · isFetching · refetch)만 고른다
```

`Cache`(`getData` · `invalidate` · `fetch` · `setData`)도 배열을 받는다. `fetch` 목록은 하나라도 실패하면 그 오류로 거절한다.

**무효화 범위.** `invalidate([])` 는 아무것도 하지 않고, `invalidate()` 는 받아 둔 것 모두를 고른다. 고른 칸 가운데 화면이 보는 칸과 받는 중인 칸만 곧바로 다시 받고(`await` 는 이것만 기다린다), 나머지는 값을 두고 낡음만 표시한다 — 화면이 다시 보거나 `fetch` 하면 그때 받고, `getData` 는 쥔 값을 준다.
앞 판에서 옮길 때: 화면 없이 새 값이 필요하면 `invalidate` 뒤 `getData` 가 아니라 `fetch` 를 쓴다 — 보지 않는 칸은 무효화가 곧바로 다시 받지 않는다.

**조건 무효화.** `invalidate((a) => a.repo === "A")` 는 받아 둔 칸마다 조건을 불러 참인 칸을 고른다. 범위 규칙은 위와 같다. 그래서 query 의 args 는 함수로 짓지 않는다.

**놓기(`release`).** `createResource(define, { release: 0 })` 은 그 args 를 보던 마지막 화면이 빠지면 칸을 놓고, `release: 5 * 60_000` 은 5분 뒤 놓는다. 그사이 화면이 다시 보면 놓지 않는다. 놓을 때 진행 중인 요청의 응답은 버리고, 놓은 뒤 다시 보면 `loading` 부터 받는다. 화면이 아닌 읽기(`getData` · `fetch`)는 보는 것으로 세지 않는다 — 화면 없이 `fetch` 로 받은 칸은 받기가 끝난 때부터 센다. 생략하거나 `false` 면 놓지 않는다. `release: 0` 은 같은 차례가 아니라 다음 차례에 놓는다 — 같은 args 를 곧바로 다시 거는 렌더(StrictMode 의 두 번 돌기 같은 것)에서 놓았다가 처음부터 다시 받지 않게. `setData` 로만 채운 칸도 보는 화면이 없으면 그때부터 센다.

**자원의 `args` 는 배열이나 튜플 타입으로 짓지 않는다** — 맨 배열을 목록으로 읽기 때문이다. 여러 값은 객체로 묶는다.

### 바꾸기: mutate 와 mutateAsync

둘 다 `pending` · `data` · `error` 를 똑같이 고친다. `mutate` 는 아무것도 돌려주지 않고 실패를 `error` 에만 둔다. `mutateAsync` 는 결과를 돌려주고 실패하면 원래 오류를 던진다.

```tsx
const { save } = useStore(dirLevel, { pick: ["save"] });
save.mutate("a");                          // 칸만 고친다
const n = await save.mutateAsync("a");     // 결과를 받고, 실패는 catch 로 받는다
```

바꾸기 이름은 `data` · `status` · `error` · `isPlaceholderData` · `isFetching` · `refetch` · `fetch` · `getData` · `setData` · `invalidate` 와 겹칠 수 없다.

**바꾸기의 상태는 자원이 쥔다.** 바꾸기마다 `inflight`(보냈지만 응답이 오지 않은 호출들의 인자 배열) · `optimistic`(겹에 얹을 호출들의 인자 — `inflight` 에서 밀려난 호출을 빼고, `onAllSettled` 를 적었으면 확인을 기다리는 성공한 호출을 더한 것) · `pending`(`inflight.length > 0`) · `error` · `data` 와 `reset()` 이 있고, 같은 핸들을 꺼낸 모든 화면과 store 가 같은 값을 본다. 화면에서는 `useStore(dirLevel).save.inflight`, store 에서는 `ctx(dirLevel).save.inflight` 로 읽는다(`ctx(dirLevel).save(…)` 는 지금처럼 함수로 부른다 — 그 호출도 `inflight` 에 보인다). 새 호출이 시작되면 `error` 가 지워지고, 실패해도 앞 `data` 는 남는다. `reset()` 은 `error` · `data` 를 지우고 모든 화면에 알리지만 `inflight` 는 지우지 않는다. 그 앞에 보낸 호출은 끝나도 `data` · `error` 를 적지 않지만 콜백은 부른다.

**겹 얹기.** 바꾸기를 보낸 직후 `optimistic` 을 캐시에 얹어 임시로 보인다. 겹은 캐시에 쓰지 않으므로, 끝나면 서버가 준 값이 그대로 남고 실패하면 겹이 빠지며 돌아간다. `select` 가 읽은 바꾸기 상태가 바뀌면 그 `select` 만 다시 돈다 — 정의를 다시 짓지 않고 다시 받지도 않는다. 안에서 읽는 `ctx` 는 상대의 원래 상태를 주고 상대의 `select` 결과를 주지 않으므로 한 단계에서 멈춘다.

```ts
// 받기와 바꾸기가 한 store 에 있을 때 — creator 가 ctx 를 받으므로 자원 타입을 적는다
type AppearanceApi = {
  patch(p: AppearancePatch): Promise<Appearance>;
  patchIcons(p: IconPatch): Promise<Appearance>;
};
// onSuccess · select 에서 ctx() 로 자기 자신을 읽으므로 ofContext 가 아니라 타입을 적는 꼴이다
export const appearance = createStore<Resource<void, Appearance, AppearanceApi>>((_set, _get, ctx) =>
  createResource(() => ({
    query: fetchAppearance,
    async patch(p: AppearancePatch) { return readAppearance(await http.patch("/api/appearance", p)); },
    async patchIcons(p: IconPatch) { return readAppearance(await http.patch("/api/appearance/icons", p)); },
  }), {
    scope: { patch: { id: "settings" }, patchIcons: { id: "settings" } },
    onSuccess: {
      patch: (next) => ctx().setData(next),
      patchIcons: (next) => ctx().setData(next),
    },
    select: (s) => {
      const self = ctx();
      return [...self.patch.optimistic, ...self.patchIcons.optimistic].reduce((acc, [p]) => acc.with(p), s);
    },
  }),
);

// 받기와 바꾸기가 다른 store 에 있을 때 — 바꾸기가 event 를 내고, 받는 쪽이 겹을 얹고 값을 채운다
export const settingsPatched = createStore(() => createEvent<{ settings: Settings }>());

export const patchSettings = createStore.ofContext((ctx) =>
  createResource(() => ({
    async patch(p: SettingsPatch) { return readSettings(await http.patch("/api/settings", p)); },
  }), {
    scope: { patch: { id: "settings" } },
    onSuccess: { patch: (settings) => ctx(settingsPatched).emit({ settings }) },
  }),
);

export const getSettings = createStore.ofContext((ctx) => {
  const settings = createResource(() => ({ query: fetchSettings }), {
    select: (s) => ctx(patchSettings).patch.optimistic.reduce((acc, [p]) => acc.with(p), s),
  });
  ctx(settingsPatched).on(({ settings: next }) => settings.setData(next));
  return settings;
});
```

두 꼴 모두 화면은 `useStore(getSettings)` 로 꺼내기만 한다. 겹이 있다는 것을 몰라도 된다.

**결과 처리와 호출 순서.** `createResource` 옵션에 바꾸기 이름을 열쇠로 `onSuccess(result, ...args)` · `onError(error, ...args)` · `onSettled(result, error, ...args)` · `onAllSettled()` 와 `scope: { [name]: { id } }` 를 적는다. 기본은 동시에 보낸다. 같은 `scope.id` 의 바꾸기는 store 가 달라도 한 줄에 서서 차례대로 나가고, 기다리는 호출의 인자도 `inflight` 에 보인다. 호출 하나는 `inflight` 에 들어가고 → 함수가 돌고 → `data`/`error` 와 콜백이 일어난 **뒤에** `inflight` 에서 빠진다. 그래서 성공하면 캐시가 먼저 서버 값이 되고 그다음에 겹이 빠진다. 콜백이 던지면 `console.error` 로 남기고 `mutateAsync` 에는 영향이 없다. 다른 곳에 결과를 넘기는 `emit` · `setData` 는 바꾸기 함수 안이 아니라 `onSuccess` 에 적는다 — 밀려난 응답이면 부르지 않기 때문이다.

**밀려남.** 같은 바꾸기에서 나중에 보낸 호출이 **성공**하면 그 앞에 보낸 호출은 모두 밀려난다. 밀려난 호출은 그 순간 `optimistic` 에서 빠지고(`inflight` 에는 응답이 올 때까지 남는다), 그 응답은 `data` · `error` 를 고치지 않고 콜백도 부르지 않는다. 그 호출의 `mutateAsync` 는 자기 결과로 끝난다. 나중 호출의 실패는 아무것도 밀어내지 않는다 — 앞 호출이 나중에 성공하면 그 `onSuccess` 가 돈다.

**서버가 받은 차례대로 처리하지 않을 수 있으면** `onAllSettled` 로 마지막에 한 번 다시 받거나 `scope` 로 줄을 세운다. `onAllSettled: { [name]: () => … }` 는 그 바꾸기의 `inflight` 가 빌 때마다 한 번 돈다(호출이 하나여도, 마지막 호출이 실패해도). 적지 않으면 돌지 않는다. 돌려준 Promise 가 끝날 때까지 성공한 호출이 `optimistic` 에 남으므로(실패한 호출은 바로 빠진다) 다시 받은 값이 오기 전에 옛 캐시가 그려지지 않는다. 확인하는 동안 `pending` 은 `false` 다. 확인 중에 새 호출이 성공해 `setData` 하면 그보다 먼저 떠난 확인 응답은 캐시를 덮지 못한다. `invalidate()` 의 다시 받기가 실패하면 그 실패는 받은 칸의 `error` 에 남고, 함수가 직접 던지면 `console.error` 로 남긴다.

```ts
// 위 appearance 처럼 타입을 적어 정의한 store 안 — ctx() 가 자기 타입을 알아야 한다
createResource(() => ({ query: fetchAppearance, async patch(p: AppearancePatch) { /* … */ } }), {
  onSuccess: { patch: (next) => ctx().setData(next) },
  onAllSettled: { patch: () => ctx().invalidate() },
  select: (s) => ctx().patch.optimistic.reduce((acc, [p]) => acc.with(p), s),
});
```

**`scope` 안에서 같은 줄을 기다리지 않는다.** 바꾸기 함수가 같은 `scope.id` 의 다른 바꾸기를 부르고 `await` 하면 그 호출은 자기 뒤에 서므로 영원히 끝나지 않는다.

**캐시 맞추기는 `onSuccess` 에서 `setData` · `emit` 으로 한다.** `onSuccess` 에서 `invalidate()` 로 다시 받기를 기다리는 길은 받기가 끝나기 전에 겹에서 빠지므로 겹이 먼저 사라져 옛 값이 잠깐 보인다. 다시 받아야 하면 `onAllSettled` 에 적는다 — 그 확인이 끝날 때까지 겹이 남는다.

**`ctx()`.** 인자 없이 부르면 자기 자신의 상태다. 정의 함수가 도는 동안에는 부를 수 없고 `짓는 동안에는 자기 자신을 꺼낼 수 없다: <이름>` 으로 막힌다. `select` · 콜백 · 바꾸기 함수 · event 를 받는 쪽에서는 언제나 쓸 수 있다. 골라 꺼내려면 자기 핸들로 `ctx(appearance, { pick })` 을 쓴다.

### 주기적으로 다시 받기

```ts
createResource(define, { refetchInterval: 60_000 });                  // 자원이 정한다
useStore(todos, { refetchInterval: 5_000 });                    // 자원이 정하지 않은 args 를 화면이 채운다
useStore(dirLevel, { args, refetchInterval: (a) => (a.dir === "" ? 10_000 : false) });
```

- 값은 `number | false | (args) => number | false | undefined`. 자원이 숫자를 정한 `args` 는 화면의 값을 보지 않는다. 자원이 정하지 않았으면 그 `args` 를 보는 화면들 가운데 가장 짧은 간격을 쓴다.
- 타이머는 `args` 하나에 하나다. 그 `args` 를 보는 화면이 있는 동안만 돌고, 받기가 끝난 때부터 간격을 센다.
- 창이 가려지면(`document.visibilityState === "hidden"`) 멈추고, 다시 보일 때 간격이 지났으면 곧바로 한 번 받는다.
- 실패하면 간격을 두 배씩 늘려 기본 간격의 8배까지 간다. 한 번 성공하면 기본 간격으로 돌아온다.
- 받은 값이 있는 `args` 를 다시 받는 동안(주기 받기 · `refetch` · `invalidate`) `status` 는 그대로다 — `ready` 는 `ready`, 실패한 뒤면 `error`. `"loading"` 은 받은 값이 없을 때뿐이다. 새로 고치는 표시는 요청이 진행 중이면 `true` 인 `isFetching` 에 건다.
- 서버 렌더에서는 타이머를 걸지 않는다. `auto: false` 인 자원도 간격이 정해진 `args` 는 주기로 받는다.

### 자리 채우기

받은 값이 없는 동안(받는 중이거나 실패한 뒤) 보일 값을 정한다. 보이는 `data` 가 자리 채운 값이면 `isPlaceholderData` 가 `true` 다. 자리 채운 값은 그 화면에만 보인다.

```tsx
import { keepPreviousData } from "supa-store/query";

useStore(dirLevel, { args: { repo, dir }, placeholderData: [] });                        // 지어낸 값
useStore(dirLevel, { args: { repo, dir }, placeholderData: keepPreviousData });           // 바로 전 값을 잇는다
useStore(dirLevel, { args: { repo, dir }, placeholderData: keepPreviousData((a, p) => p.args.repo === a.repo) });
useStore(dirLevel, { args: { repo, dir }, placeholderData: (a, prev) => prev[0]?.data });  // 직접 짓는다
```

- **`keepPreviousData` 는 그대로 `placeholderData` 에 넘기거나 `keepPreviousData(match)` 로 쓴다.** `(a, p) => keepPreviousData(a, p)` 로 감싸면 목록 꼴의 동작을 잃는다.
- 그대로 넘기면 하나 꼴에서는 바로 전 값을 잇고, 목록 꼴에서는 같은 `args` 의 앞 값만 잇는다. 항목이 끼어들어도 옆 항목의 값이 밀려오지 않는다.
- 자원의 것을 먼저 구하고, 정하지 않았으면(`undefined`) 화면의 것을 쓴다.
- 인라인 함수여도 된다. `useCallback` 이 필요 없다.

### 바꾸어 꺼내기(select)

```ts
createResource(define, { select: (data, args) => data.map((t) => t.title) });       // 캐시는 그대로, 화면에 줄 때만 바꾼다
useStore(todos, { select: (titles) => titles.length });                         // 자원 select 의 결과를 이어 받는다
```

- 자원의 `select` 는 `getData` · `setData` · `fetch` 의 모양을 바꾸지 않는다. 화면의 `select` 는 자원 `select` 의 결과를 이어 받는다.
- 자리 채운 값에도 `select` 를 거친다. 목록 꼴에서는 항목마다 불린다.
- 바꾼 결과를 바로 전과 겉 한 겹(`Object.is`)으로 견주어 같으면 다시 그리지 않는다. **깊이 견주지 않으므로, 새 응답마다 새 배열이나 새 객체를 안에 담아 돌려주면 응답마다 다시 그린다.** 필요한 값만 돌려준다.
- `select` · `placeholderData` 를 렌더마다 새 함수로 적어도 된다.

### React Query 에서 옮겨 올 때

| React Query | supa-store |
|---|---|
| `useQuery` | `useStore(handle, { args })` |
| `useQueries` | `useStore(handle, { args: [...] })` |
| `useMutation` 의 `mutate` · `mutateAsync` | 같은 이름. `useStore(handle)` 에서 바꾸기 이름으로 꺼낸다 |
| `refetchInterval` | 같은 이름(자원 또는 화면) |
| `placeholderData` · `keepPreviousData` | 같은 이름 |
| `select` | 같은 이름(자원 또는 화면) |
| `setQueryData` · `getQueryData` | `getData(args)` · `setData(updater, args)` |
| `invalidateQueries` | `invalidate(args)`, 다른 자원이 바뀔 때는 event 의 `on` |
| `onMutate` 낙관적 갱신 · `useInfiniteQuery` | 바꾸기 함수 안에서 `getData` · `setData` |
| `onSuccess` · `onError` · `onSettled` · `scope.id` | 같은 이름(`createResource` 옵션, 바꾸기 이름이 열쇠). 낙관적 표시는 `optimistic` 겹. 모든 호출이 끝난 뒤 한 번 다시 받기는 `onAllSettled` |

**TanStack 과 다른 점.** supa-store 의 콜백은 밀려난 응답에서 부르지 않는다. 같은 바꾸기에서 나중에 보낸 호출이 성공했으면 앞 호출의 `onSuccess` · `onError` · `onSettled` 는 불리지 않고 `data` · `error` 도 그대로다(그 호출의 `mutateAsync` 는 자기 결과로 끝난다). 이 단위는 화면이 아니라 자원의 바꾸기 이름이어서, 어느 화면 · store 에서 불렀든 같다. `onAllSettled` 는 TanStack 에 없다 — 호출마다가 아니라 그 바꾸기의 모든 호출이 끝났을 때 한 번 돈다.

```ts
import type { Cache } from "supa-store/query";

// 캐시를 직접 읽고 쓴다 — store 안에서는 ctx, 밖에서는 getStore
ctx(settings).getData();
ctx(settings).setData((prev) => ({ ...prev!, theme: "dark" }));

// 낙관적 갱신 — 실패하면 앞 값으로 되돌린다. 늦게 온 조회 응답은 setData 가 이미 버린다
createResource((cache: Cache<void, Settings>) => ({
  query: fetchSettings,
  async save(patch: Partial<Settings>) {
    const prev = cache.getData();
    cache.setData((s) => ({ ...s!, ...patch }));
    try {
      const saved = await putSettings(patch);
      cache.setData(saved);
      return saved;
    } catch (e) {
      cache.setData(prev); // 받은 적 없던 칸이면 undefined 라 idle 로 돌아간다
      throw e;
    }
  },
}));

// 쪽 단위로 이어 받기 — data 를 쪽 배열로 두고 바꾸기가 다음 쪽을 이어 붙인다
createResource((cache: Cache<{ sessionId: string }, Page[]>) => ({
  query: async ({ sessionId }) => [await fetchPage(sessionId, null)],
  async loadMore(sessionId: string) {
    const pages = cache.getData({ sessionId }) ?? [];
    const next = await fetchPage(sessionId, pages.at(-1)?.cursor ?? null);
    cache.setData([...pages, next], { sessionId });
  },
}));

// 다른 자원이 바뀌면 낡게 한다 — event 를 듣는다
export const graph = createStore.ofContext((ctx) => {
  const resource = createResource(() => ({ query: fetchGraph }));
  ctx(repoChanged).on(() => void resource.invalidate()); // 다시 지으면 앞 듣기는 떨어진다
  return resource;
});
```

### 0.4 에서 옮길 때

- 바꾸기 상태가 화면 사이에 나뉜다. 같은 자원의 바꾸기를 꺼낸 두 화면이 `pending` · `error` · `data` 를 함께 보고, 한 화면의 `reset()` 이 다른 화면의 `error` 도 지운다.
- 늦은 응답을 가리는 단위가 화면에서 자원의 바꾸기 이름으로 넓어졌다. 어느 화면 · store 에서 불렀든 나중 호출이 성공하면 앞 호출은 밀려나 그 응답이 버려진다. 나중 호출이 실패하면 앞 응답은 버려지지 않는다.
- 바꾸기는 동기 함수여도 부르면 언제나 Promise 를 돌려준다(타입도 그렇다). 동기로 던지던 것은 거절된 Promise 가 된다.
- 정의 파일은 고치지 않아도 된다.

### 0.1.0 에서 옮길 때

- `mutate` 는 이제 결과를 돌려주지 않는다. `await x.mutate(...)` 의 결과를 쓰던 코드는 `mutateAsync` 로 바꾼다.
- `args` 를 배열 타입으로 짓지 않는다. 객체로 묶는다.
- `QueryView` 에 `isPlaceholderData` · `isFetching` 칸이 늘었다. 정의 파일은 고치지 않아도 된다.
- 값이 있는 `args` 를 다시 받는 동안 `status` 가 `"loading"` 으로 바뀌지 않는다. `refetch` · `invalidate` 뒤에 `status === "loading"` 을 기다리던 코드는 `isFetching` 을 본다.

## 서버와 이어진 연결(createStream)

웹소켓이나 SSE 로 서버와 이어진 값을 store 상태로 꺼낸다. 서버가 처음에 `snapshot` 을 주고 이후 `change` 를 보내면 `reduce` 로 값에 얹는다.
끊기면 다시 잇고, 빠진 바뀜은 서버의 짧은 기록에서 따라잡는다. 하위 경로 넷: `supa-store/stream`(화면) · `supa-store/server`(정의) ·
`supa-store/server/node` · `supa-store/server/web`(진입점). 화면 쪽은 런타임 의존이 없다.

### 클라이언트 정의

명령의 이름과 인자 · 결과 타입은 셋째 타입 인자로 적고, 명령마다 `commands` 에 한 칸(제한 시간, 없으면 `{}`)을 둔다.
타입은 런타임에 남지 않으므로 이름은 `commands` 가 들고, 빠진 명령은 타입 오류다.

```ts
import { createStore } from "supa-store";
import { createStream } from "supa-store/stream";

type Change = { op: "append"; chunk: string };
type Commands = { open(cwd: string): string; kill(id: string): void };

export const terminal = createStore(() =>
  createStream<string, Change, Commands>({
    url: "/ws/terminal", // 상대 주소는 location 으로 푼다(웹소켓이면 http → ws)
    transport: "ws", // 또는 "sse"
    channel: "default", // 생략하면 "default"
    auth: () => getToken(), // 생략하면 쿠키만
    reduce: (out, c) => out + c.chunk, // 생략하면 change 를 새 값 전체로 본다
    commands: { open: {}, kill: { timeout: 5_000 } },
    handlers: { confirm: async (message: string) => window.confirm(message) }, // 서버가 묻는 요청에 답한다
    timeout: 30_000, // 명령의 기본 제한 시간
  }),
);
```

`window` 가 없으면(서버에서 그릴 때) 열지 않고 `loading` 그대로다. Node 에서 열려면 `open: "always"` 이고, 이때 웹소켓은 전역
`WebSocket`(Node 22 이상)이나 `ws` 패키지가 있어야 한다.

### 화면이 꺼내는 칸

```tsx
const { data, status, isFetching, error, open } = useStore(terminal, { pick: ["data", "status", "isFetching", "error", "open"] });
await open.mutateAsync("/repo"); // 실패하면 던진다
```

연결의 칸(`data` · `status` · `isFetching` · `error`)과 명령마다의 칸(`mutate` · `mutateAsync` · `pending` · `error` · `data` · `reset` · `retry`)이 있다.
다른 store 에서는 `getStore(terminal).getState().open("/repo")` 처럼 명령 함수로 부르고, 실패하면 던진다.

### 연결 상태

| 때 | `data` | `status` | `isFetching` | `error` |
|---|---|---|---|---|
| 처음 연결 중 | `undefined` | `loading` | `true` | `null` |
| 이어져 값을 받는 중 | 지금 값 | `ready` | `false` | `null` |
| 끊겨 다시 잇는 중 | 마지막 값 그대로 | `ready` | `true` | 연결 끊김. 재시도 중.. |
| 다시 이어져 빠진 바뀜을 받았다 | 따라잡은 값 | `ready` | `false` | `null` |
| 서버가 「다시 오지 마라」로 닫았다 | 마지막 값 그대로 | `error` | `false` | 닫은 까닭 |
| 처음 연결이 「다시 오지 마라」로 거절됐다 | `undefined` | `error` | `false` | 닫은 까닭 |

마지막 값은 비우지 않는다. 연결 상태를 따로 담는 칸은 없다. 다시 잇기는 1초부터 두 배씩 30초까지 늘며(±20% 흔든다), 창이 가려져도 잇는다.

### 문구

| 자리 | 언제 보이나 | 문구 |
|---|---|---|
| 연결의 `error` | 연결이 끊겨 다시 잇는 동안 | 연결 끊김. 재시도 중.. |
| 명령의 `error` · `mutateAsync` 의 거절 | 끊긴 동안 부른 명령, 다시 이은 뒤 서버가 받은 적 없다고 답한 명령 | 연결 끊김. 명령 실패 |
| 같은 자리 | 보낸 뒤 끊겼고 다시 이은 뒤에도 결과를 확인하지 못한 명령 | 연결 끊김. 알 수 없음 |
| 같은 자리 | 제한 시간 안에 답이 오지 않은 명령 | 응답 지연 |

「재시도 중」은 연결에만 쓴다. 명령은 저절로 다시 보내지 않는다. 서버 앱이 `ok: false` 로 답한 실패는 앱이 보낸 문구를 그대로 쓴다.

### retry()

명령의 칸에 있는 `retry()` 는 마지막으로 실패한 명령을 같은 요청 id · 인자로 다시 보낸다. 서버는 같은 id 를 다시 돌리지 않고 쥔 답을
주므로, 이미 돌았던 명령이 두 번 돌지 않는다. 앱이 `ok: false` 로 답했던 명령에 `retry()` 하면 같은 실패가 돌아온다 — 새로 부르려면
`mutate` 를 쓴다. 쥐고 있는 실패는 `reset()` 이 지우고, 뒤이은 성공도 지운다. 실패한 명령이 없으면 `retry()` 는 거절한다.

### 서버 정의

```ts
import { createStreamServer } from "supa-store/server";

export const terminal = createStreamServer<string, Change>({
  authorize: async (ctx) => (await verify(ctx.token)) ?? ctx.reject("인증 실패"), // 신원을 돌려주거나 거절한다
  channel: (ctx) => ctx.channel ?? "default", // 기본은 클라이언트가 청한 채널, 없으면 "default"
  snapshot: (ctx) => outputOf(ctx.channel), // 동기 — 부르는 순간의 채널 버전이 그 값의 버전이다
  commands: {
    open: async (ctx, cwd: string) => {
      const id = spawnPty(cwd, (chunk) => terminal.publish(ctx.channel, { op: "append", chunk }));
      return id;
    },
    kill: (ctx, id: string) => killPty(id),
  },
  history: { count: 1000, ms: 5 * 60_000 }, // 기본: 최근 1000 개 또는 5분 가운데 짧은 쪽
});
```

`snapshot` 은 동기 함수다(`async` 로 적지 않는다). 비동기로 읽어야 하는 값은 미리 쥐어 두고 `snapshot` 이 그것을 돌려준다.
`publish(channel, change)` 는 그 채널에 붙은 모두에게 보낸다. 채널마다 버전 · 기록 · 답 기록을 따로 쥐므로 사람마다 다른 값은 채널에 신원을 넣어 나눈다.
명령 안의 `ctx.request(method, params)` 는 클라이언트의 `handlers` 에 묻는다.
보내는 값은 JSON 으로 쓸 수 있어야 한다. 쓸 수 없는 값(BigInt · 순환 객체 · 프로세스 핸들)이면 명령은 `ok: false` 로 답하고, `snapshot` 은 그
연결만 「곧 다시 와라」로 닫고, `publish` 는 버전을 올리지 않고 부른 쪽에 던진다.

읽지 않는 연결에 버퍼가 끝없이 쌓이지 않게, 홉은 보내기 직전에 그 연결에 아직 나가지 못한 바이트를 잰다. 그것이 `maxBuffered`(기본
`4 * 1024 * 1024`, `Infinity` 면 재지 않는다)를 넘었으면 그 메시지를 보내지 않고 연결을 4000 `"버퍼가 넘쳤다"` 로 닫는다. 웹소켓은 그에
더해 마지막으로 무엇이든 받은 지 60초가 지난 뒤 다음 ping 자리에서 4000 `"응답이 없다"` 로 닫는다. 4000 은 「곧 다시 와라」라서
클라이언트는 마지막 버전으로 다시 잇고 짧은 기록이나 snapshot 으로 따라잡는다.
Web 진입점은 응답 몸통에 쌓인 양을 잰다 — 런타임이 받는 쪽 속도에 맞춰 몸통을 읽을 때만 한도가 지켜진다.
직접 지은 `Conn` 은 `buffered()` 를 채우면 한도가 걸린다(비워 두면 재지 않는다).

### 두 진입점

```ts
// Node http 서버 — 웹소켓과 SSE 를 같은 주소에서 받는다
import { attachStream } from "supa-store/server/node";
const detach = attachStream(httpServer, { path: "/ws/terminal", stream: terminal });
```

```ts
// Web 표준 — (req: Request) => Promise<Response>. Hono · Next 라우트 · Bun · Deno
import { streamHandler } from "supa-store/server/web";
export const GET = streamHandler(terminal); // SSE
export const POST = streamHandler(terminal); // 명령 · ask · answer
```

- `attachStream` 의 웹소켓은 선택 peer `ws`(`>=8`)로 받는다. 설치하지 않았으면 SSE 만 받는다. **http 서버 하나에 `attachStream` 은 한 번만** 건다.
- **Web 표준 진입점은 SSE 만 받는다.** 웹소켓으로 갈아타는 길은 런타임마다 달라 두지 않았다. 이런 틀의 앱은 클라이언트를 `transport: "sse"` 로 적는다.
- 명령의 `POST` 본문과 웹소켓 메시지 하나는 1 MiB 까지 받는다(넘으면 413, 웹소켓은 1009 로 닫는다).
- 서버 쪽은 Node 20 이상(전역 `crypto` · `fetch`)이 필요하다.

### 인증

`auth()` 의 값은 웹소켓이면 `hello.auth` 로, SSE 와 명령의 `POST` 면 `Authorization` 헤더로 싣고, 다시 이을 때마다(SSE 는 `POST` 마다도) `auth()` 를 다시 부른다.
**토큰을 주소의 쿼리에 싣지 않는다.** `auth` 가 없으면 쿠키만 쓴다. 서버의 `authorize` 가 거절하면 「다시 오지 마라」로 닫혀 다시 잇지 않는다.
웹소켓은 10초 안에 `hello` 가 오지 않아도 서버가 닫는다.

**쿠키로 인증하면 `origins` 를 둔다.** 웹소켓은 CORS 를 따르지 않으므로 남의 사이트가 사용자의 쿠키로 연결을 열 수 있다.
`attachStream(server, { path, stream, origins: ["https://app.example"] })` · `streamHandler(stream, { origins })` 는 `Origin` 헤더가
있고 목록에 없는 요청을 403 으로 막는다(`Origin` 이 없는 브라우저 밖의 요청은 받는다). 또는 `authorize` 에서 `ctx.headers.origin` 을 본다.

### 시험에서

```ts
import { disposeStores } from "supa-store";
afterEach(() => disposeStores()); // 열린 연결을 닫는다(store 는 다음에 꺼낼 때 다시 짓는다)
```

`disposeStores()` 는 그려져 있는 화면을 다시 그리지 않는다 — 시험의 뒷정리에 쓴다.

## 프로세스와 다른 서버에 붙기(createJsonRpc)

서버 앱이 띄운 프로세스(언어 서버 · MCP 서버)나 다른 서버에 JSON-RPC 2.0 으로 붙고, 상대가 보낸 알림을 값으로 쌓는다. 끊기면 다시 잇고
`onConnect` 로 상대와 다시 맞춘다. 하위 경로는 `supa-store/rpc` 하나이고 Node 20 이상의 서버 앱 전용이다(`websocket` 은 `ws` 가 있어야 한다).
브라우저는 이 연결에 직접 붙지 않고 0.3 의 홉을 거친다.

### 정의

값의 타입은 첫째, 상대가 보내는 알림은 둘째, 요청은 셋째, 보낼 알림은 넷째 타입 인자다. 요청과 보낼 알림은 이름마다 `requests` ·
`notifications` 에 한 칸이 있어야 하고, 빠지면 타입 오류다. 요청 함수는 인자를 하나만 받는다(그것이 `params` 가 된다).

```ts
import { createStore } from "supa-store";
import { createJsonRpc, stdio } from "supa-store/rpc";

type Note = { method: "textDocument/publishDiagnostics"; params: PublishDiagnosticsParams };
type Cmd = {
  complete: (p: CompletionParams) => CompletionList;
  definition: (p: DefinitionParams) => Location[];
};

export const lsp = createStore(() =>
  createJsonRpc<{ diagnostics: Record<string, Diagnostic[]> }, Note, Cmd, { didChange: DidChangeTextDocumentParams }>({
    connect: () => stdio(spawn("typescript-language-server", ["--stdio"]), { framing: "content-length" }),
    onConnect: async (last, rpc) => {
      await rpc.request("initialize", { processId: process.pid, rootUri, capabilities: {} });
      rpc.notify("initialized", {});
      for (const doc of openDocs()) rpc.notify("textDocument/didOpen", { textDocument: doc }); // 처음이든 다시든 지금 문서를 보낸다
      return last ?? { diagnostics: {} };
    },
    reduce: (value, n) => ({ diagnostics: { ...value.diagnostics, [n.params.uri]: n.params.diagnostics } }),
    requests: {
      complete: { method: "textDocument/completion", timeout: 5_000 },
      definition: { method: "textDocument/definition" },
    },
    notifications: { didChange: "textDocument/didChange" },
    handlers: { "workspace/configuration": () => [{}] }, // 상대가 묻는 요청. 없으면 -32601 로 답한다
    cancel: (id) => ({ method: "$/cancelRequest", params: { id } }), // 응답 지연으로 끝낸 요청을 상대에게 알린다
  }),
);
```

`framing` 은 메시지를 자르는 법이다. `"content-length"` 는 LSP 의 길이 머리, `"ndjson"` 은 한 줄에 메시지 하나(MCP)다.
`websocket(url, { headers?, maxPayload? })` 는 JSON-RPC 를 말하는 웹소켓 서버에 붙는다. `ws` 가 없으면 그 문구가 `error` 에 실리고 다시 시도한다. 다른 통로는 `Transport` 꼴로 직접 지어 `connect` 가 돌려주면 된다.

store 로 꺼낸 것은 다른 store 가 `ctx` 로 부른다. 화면에서는 쓰지 않는다.

```ts
export const complete = createStore.ofContext((ctx) => ({
  run: (p: CompletionParams): Promise<CompletionList> => ctx(lsp).complete(p),
}));
```

### store 없이 바로 쓰기

```ts
// Out 은 위 정의의 알림 보내기 꼴(여기서는 { didChange: DidChangeTextDocumentParams })
const lsp = createJsonRpc<Value, Note, Cmd, Out>({ /* 위와 같다 */ });

app.post("/complete", async (req, res) => res.json(await lsp.complete(req.body)));
lsp.subscribe(() => hop.publish("lsp", lsp.view().data)); // 0.3 의 홉으로 브라우저에 보낸다
process.on("SIGTERM", () => lsp.close());
```

- 요청 함수는 결과를 돌려주고, 상대가 실패로 답하면 `RpcError`(`message` · `requestId` · `code` · `data`)를 던진다.
- 준비 전에 부른 요청은 제한 시간 안에서 기다렸다가 부른 순서대로 나간다. 준비 전에 부른 알림은 버리고 `false` 를 돌려준다
  (처음 열 때도 다시 이을 때도 같다). 상태를 맞추는 일은 `onConnect` 한 곳이 한다.
- `stdio` 는 닫을 때(`close()`) 표준 입력을 닫고, `killAfter`(기본 2초) 안에 끝나지 않으면 프로세스를 끝낸다.
  Windows 에서 `shell: true` 로 띄운 래퍼(예: npx.cmd)는 `kill()` 이 래퍼만 끝내 손자 프로세스가 남을 수 있으니 실행 파일을 직접 띄운다.
- `request` · `notify` · `view` · `subscribe` · `close` 는 이름이 정해져 있어 요청 · 알림 이름으로 쓸 수 없다.

### 전제

store 꼴은 서버 전용 모듈에서만 쓴다. 그 핸들을 import 하는 쪽의 묶음에 `child_process` 가 따라 들어가므로, 화면 코드가 그 정의 파일을
import 하지 않게 둔다. 그렇게 가르기 어려운 프로젝트는 위의 바로 쓰는 꼴을 쓴다.

## Next.js 와 그 밖의 도구

Next 는 `next.config` 를 `withStore` 로 감싼다. 객체 설정도 (async) 함수 설정도 받는다.

```js
// next.config.mjs
import { withStore } from "supa-store/next";
export default withStore({});
```

개발 모드에서 webpack loader 하나를 더해 정의 파일이 HMR 갱신을 받지 않게 한다. 받지 않은 갱신은 webpack 이 페이지 전체 다시 읽기로 처리한다. 정의 파일이 기대는 모듈을 고친 경우도 갱신이 정의 파일에서 멈추므로 같다. 빌드에서는 아무것도 더하지 않는다.

- **Next 16 부터 `next dev` 는 기본으로 Turbopack 을 쓴다.** Turbopack 개발 서버에는 webpack loader 가 걸리지 않는다. 이 막기를 쓰려면 `next dev --webpack` 으로 띄우고, Turbopack 으로 띄우면(Next 15 까지는 `next dev --turbopack`) 정의 파일을 고친 뒤 직접 새로 고친다.
- Vite 도 Next 도 아니면 장치가 없다. 정의 파일을 고친 뒤 직접 새로 고친다.

**정의 파일은 `supa-store` 에서 `createStore` 를 가져오는 파일로 가린다.** `import { createStore } from "supa-store"`(`as` 로 이름을 바꿔도 된다)와 `import * as s from "supa-store"` 를 알아본다. 아래 꼴은 알아보지 못해, 그 파일을 고쳐도 페이지를 다시 읽지 않는다. store 는 `supa-store` 에서 `createStore` 를 바로 가져와 정의한다.

- `createStore` 를 다시 내보내는 지역 감싸개(`export { createStore } from "supa-store"`)를 거쳐 가져온 파일
- 동적 `import("supa-store")`
- `import def, * as s from "supa-store"` 처럼 기본 가져오기와 이름 공간 가져오기를 한 줄에 적은 꼴

## 0.7.0 에서 옮길 때

깨지는 것은 없다. `createStore.ofContext` 가 더해졌다. `ctx` 만 쓰려고 `createStore<Resource<…>>((_set, _get, ctx) => …)` 처럼 타입 인자를 적었거나 `(_s: unknown, _g: unknown, ctx: Ctx) =>` 로 적은 정의는 `createStore.ofContext((ctx) => …)` 로 바꾸면 타입을 지울 수 있다. 바꾸지 않아도 그대로 돈다.

## 0.6 에서 옮길 때

store 를 key 대신 `createStore` 가 돌려주는 핸들로 가리킨다. 생성 파일 · 설정 파일 · tsserver 플러그인이 없어졌다.

- `createStore("k", creator)` 는 `export const k = createStore(creator)` 로 바꾼다. creator 가 인자를 받으면 타입 인자를 적는다(위 「타입 인자를 적어야 하는 꼴」 절)
- `useStore("k", …)` · `ctx("k", …)` · `getStore("k")` · `overrideStore("k", …)` 는 핸들을 받는다 — `useStore(k, …)` · `ctx(k, …)` · `getStore(k)` · `overrideStore(k, …)`
- `.on(ctx.key, fn)` 은 `.on(fn)` 으로, `.exempt(ctx.key, why)` 는 `.exempt(why)` 로 바꾼다. `ctx.key` 는 없다
- `registeredKeys()` 는 `registeredStores()` 로 바꾼다. 문자열 대신 핸들을 준다
- 생성 파일(`store.gen.ts`)과 그 import, `store.config.ts`, tsconfig 의 `{ "name": "supa-store/plugin" }` 항목, `store-gen` 을 부르는 스크립트를 지운다. 번들러 장치(`supaStore()` · `withStore`)는 남긴다
- 닫힌 key(`_` 로 시작하는 key)는 export 경계로 바꾼다 — 닫을 store 의 핸들을 export 하지 않는다
- `vi.resetModules()` 뒤 정의 파일을 다시 import 해 정의를 갈아 끼우던 시험은 `overrideStore` 로 바꾼다. 0.7 은 다시 읽은 모듈을 새 store 로 등록한다
- `record()` 의 `who` 와 오류 문구의 key 자리에는 부른 자리의 이름(`<경로>:<줄>`)이 선다. 그 문자열을 박아 견주던 시험은 수나 포함 여부로 견준다

## 라이선스

MIT
