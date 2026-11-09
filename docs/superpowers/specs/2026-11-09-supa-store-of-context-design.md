# supa-store 0.7.1 — `ctx` 만 받는 정의 `createStore.ofContext`

- 날짜: 2026-11-09
- 바탕: 0.7.0(`dev` `8c04c96`). [0.7 설계](./2026-11-09-supa-store-handle-design.md)를 고치지 않고 더한다. 이 문서가 말하지 않은 것은 그 문서를 따른다
- 브랜치: `of-context+`
- 크기: 작은 변경. 공개 API 하나를 더하고 깨지는 것이 없다

## 1. 의도와 까닭

**`ctx` 만 쓰는 정의가 타입을 적지 않고도 추론되게 한다.**

0.7 의 `createStore(creator)` 는 creator 가 인자를 하나라도 받으면 상태 타입 `S` 를 추론하지 못한다. 인자 `set` · `get` · `ctx` 의 타입이 `S` 에 기대고, `S` 는 그 인자를 쓰는 본문이 돌려주는 값에서 나오는 순환이기 때문이다. 0.7 은 이 경우 `S` 를 기본값 `never` 로 굳혀 정의 자리에서 컴파일 오류를 낸다.

그런데 supa-store 를 쓰는 두 앱(editor · fortuna-lottery)의 정의 118 곳을 실제로 쓰는 인자로 가르면 이렇다(2026-11-09 잼).

| 실제로 쓰는 인자 | 곳 수 | 어떤 store 인가 |
|---|---|---|
| `ctx` 만 | 59 | 서버 자원(`createResource`), 다른 store 를 읽는 파생 |
| 없음 | 50 | event, 바깥 도구, 반환 타입을 적은 단순 상태 |
| `set` 만 | 8 | 화면 상태 |
| `set` · `get` | 1 | 바꾸기 밖에서 지금 값을 읽는 화면 상태 |
| `set` 과 `ctx` 를 함께 | 0 | — |

**정의의 절반이 `ctx` 만 쓴다.** 0.7 의 `(set, get, ctx)` 차례에서는 가장 많이 쓰는 인자가 맨 뒤에 있어서, 이 59 곳이 쓰지 않는 인자 둘을 적어야 한다. 게다가 추론되려면 세 인자 모두에 타입을 적어야 한다(`(_s: unknown, _g: unknown, ctx: Ctx) =>`). 자원의 타입 `Resource<…>` 를 손으로 적는 길은 인자 넷을 정의에서 다시 옮겨 적는 셈이라 버렸다. 사용자가 이 자리를 불편으로 짚었다.

`set` 을 쓰는 9 곳은 이미 반환 타입을 적거나(`(set): Shape =>`) `createStore<Shape>` 로 적으면 추론된다. zustand 의 `create<T>()` 와 같은 처지이고 그대로 둔다.

## 2. 목표 · 하지 않는 것 · 실패로 치는 것

**목표.**

- `ctx` 만 쓰는 정의를 `createStore.ofContext((ctx) => …)` 로 쓰고, 상태 타입은 돌려주는 값에서 추론된다.
- 동작은 `createStore` 로 지은 store 와 같다. 꺼내 쓰는 쪽(`useStore` · `getStore` · `ctx(handle)` · `overrideStore`)은 바뀌지 않는다.

**하지 않는 것.**

- `createStore` 의 시그니처를 바꾸지 않는다. 인자 차례도 그대로다.
- `useStore` 를 고치지 않는다. `ofContext` 로 지은 store 도 `useStore(handle, { pick | omit })` 로 필요한 칸만 꺼낸다(§3.4).
- 초깃값을 따로 받는 꼴(zustand 의 `combine`)을 더하지 않는다. 덜어 줄 곳이 `set` 을 쓰는 9 곳뿐이고, 그 9 곳은 지금 꼴로 추론된다(§5).

**실패로 치는 것.**

- `ofContext` 로 지은 store 가 `createStore` 로 지은 store 와 다르게 동작하는 것. 다시 짓기, 짓는 동안 건 듣기를 떼는 일, `overrideStore` · `resetStores` · `disposeStores`, 이름이 모두 같아야 한다.
- `ofContext` 를 쓴 정의 파일이 정의 파일로 걸리지 않아 개발 서버에서 페이지 다시 읽기가 빠지는 것.
- 이름이 `ofContext` 를 부른 정의 파일의 줄이 아니라 supa-store 안쪽을 가리키는 것.

## 3. 정한 것

### 3.1 시그니처

```ts
createStore.ofContext<S extends object>(creator: (ctx: Ctx) => S): Store<S>
```

```ts
import { createStore } from "supa-store";
import { createEvent, createResource } from "supa-store/query";

export const savedEvent = createStore(() => createEvent<{ id: string }>());

export const todos = createStore.ofContext((ctx) => {
  ctx(savedEvent).on(({ id }) => { /* id: string */ });
  return createResource(() => ({ query: fetchTodos, add: postTodo }));
});
// todos: Store<Resource<…>> — 자원의 네 타입이 fetchTodos · postTodo 에서 온다
```

- **이름.** 공개 API 이름은 낱말을 줄이지 않고 쓰는 것이 흔하다(React 의 `createContext` · `useContext`, Svelte 의 `getContext`). 그래서 메서드 이름은 `ofContext` 다. creator 가 받는 인자 이름은 지금처럼 `ctx` 이고 그 타입 이름 `Ctx` 도 그대로다. 사용자가 `ofCtx` 와 `ofContext` 가운데 흔히 쓰이는 쪽으로 정하라고 했다.
- **`createStore` 에 붙인 메서드다.** 따로 export 하는 함수로 두지 않는다. 그 까닭은 §3.5 의 정의 파일 판정이 그대로 걸리고, import 가 늘지 않으며, 편집기에서 `createStore.` 을 치면 바로 옆에 뜨기 때문이다.
- **`ctx` 의 타입은 `Ctx` 다(`Ctx<S>` 가 아니다).** 인자 타입이 `S` 에 기대면 순환이 되살아나 추론이 깨진다. 그래서 `ctx()`(자기 자신 읽기)는 `unknown` 을 돌려준다. 자기 자신은 자기 핸들로 `ctx(todos)` 처럼 읽으면 타입이 잡힌다. 두 앱에 `ctx()` 를 쓰는 곳은 없다(2026-11-09 잼, 시험 밖 editor 0 곳 · fortuna-lottery 0 곳).
- `ctx(handle)` · `ctx(handle, { pick | omit })` 은 0.7 과 같다. 짓는 동안 기댐을 적고, 계산 공간에서 읽은 것을 적고, 파생이면 값을 준다.

### 3.2 동작

`createStore.ofContext(creator)` 는 `createStore((_set, _get, ctx) => creator(ctx))` 로 등록하는 것과 같다. 그래서 0.7 의 장치가 모두 그대로 걸린다.

- 짓는 것은 처음 꺼낼 때이고, `rebuild` 가 기댐을 거슬러 다시 짓는다.
- 짓는 동안 건 `on(fn)` · `exempt(why)` 의 주인은 이 store 이고, 이 store 를 버릴 때 떨어진다.
- `overrideStore(handle, creator)` 의 creator 는 0.7 과 같은 세 인자 꼴(`(set, get, ctx) => object`)을 받는다. `ofContext` 로 지은 store 라고 해서 덮어쓰는 꼴이 달라지지 않는다.
- `registeredStores()` 에 등록 차례대로 선다.

### 3.3 이름(부른 자리)

`ofContext` 를 거치면 stack 프레임이 하나 늘어난다. **이름은 여전히 `ofContext` 를 부른 정의 파일의 `<경로>:<줄>` 이어야 한다.**

- 지금 `labelFromStack` 은 첫 프레임(stack 을 만든 함수가 사는 파일)과 같은 파일의 프레임을 모두 건너뛴다. `ofContext` 가 `createStore` 와 같은 모듈(`src/index.ts`)에 살면 그 프레임도 건너뛰어진다.
- 이것을 시험으로 박는다(§3.7).
- 배포 빌드에서는 0.7 과 같이 `#<n>` 이다.

### 3.4 꺼내 쓰는 쪽

바꾸지 않는다. `ofContext` 로 지은 store 의 핸들도 `Store<S>` 이므로 `useStore` 의 갈래가 0.7 그대로 걸린다.

```ts
const list = useStore(todos, { pick: ["data", "add"] });   // 자원: createResource 의 꺼내기
const { save } = useStore(actions, { pick: ["save"] });    // 보통 객체: 칸 고르기
const rest = useStore(actions, { omit: ["save"] });
```

화면에서 `getState` · `setState` 를 부를 일은 없다. React 밖에서 읽을 때만 `getStore(handle).getState()` 를 쓴다(0.7 과 같다). 이 세 줄은 2026-11-09 에 0.7 타입에 대고 `tsc --strict` 로 쟀다. 없는 이름을 pick 하거나 omit 으로 뺀 칸을 읽으면 오류가 난다.

### 3.5 정의 파일 판정과 번들러 장치

고치지 않는다. `ofContext` 를 쓰는 파일은 `createStore` 를 `supa-store` 에서 가져오므로 `isDefinition` 에 그대로 걸린다. 그래서 Vite 플러그인과 Next 감싸기의 페이지 다시 읽기도 그대로 걸린다. 이것을 시험으로 박는다(§3.7).

### 3.6 README

- 「정의와 꺼내기」의 자원 예시를 `ofContext` 꼴로 바꾼다.
- 「타입 인자를 적어야 하는 꼴」 절을 셋으로 나눠 고쳐 쓴다.
  - 인자 없는 creator: 추론된다.
  - `ctx` 만 쓰는 creator: `createStore.ofContext((ctx) => …)` 를 쓴다. `ctx()` 는 `unknown` 이니 자기 자신은 자기 핸들로 읽는다.
  - `set` · `get` 을 쓰는 creator: 반환 타입을 적거나(`(set): Shape =>`) `createStore<Shape>` 로 적는다.
- 0.7.0 의 `(_s: unknown, _g: unknown, ctx: Ctx) =>` 꼴도 여전히 통한다고 한 줄 적는다. 이미 그렇게 쓴 코드를 고칠 필요는 없다.

### 3.7 시험

`pnpm test` · `pnpm typecheck` · `pnpm test:pack` 이 통과해야 한다. 그 밖에 아래를 박는다.

- **타입.**
  - `createStore.ofContext((ctx) => createResource(…))` 의 상태 타입이 자원 타입으로 추론된다.
  - `ctx(eventHandle).on((payload) => …)` 의 `payload` 타입이 잡힌다.
  - `useStore(handle, { pick })` · `{ omit }` 이 고른 칸만 낸다. 없는 이름은 오류다.
  - `ctx()` 가 `unknown` 이다.
- **동작.**
  - `getStore(handle)` 이 다시 지어도 같은 객체다.
  - 짓는 동안 건 `on` 이 `overrideStore` · `resetStores` · `disposeStores` 뒤에 하나만 남는다.
  - `ofContext` 로 지은 store 에 `ctx` 로 기댄 store 가, 기댄 store 를 `overrideStore` 하면 다시 지어진다.
  - `overrideStore(ofContextHandle, (set, get, ctx) => …)` 가 덮어쓴다.
- **이름.**
  - 순환 오류와 `record()` 의 이름이 시험 파일의 `<경로>:<줄>` 이고 `src/index.ts` 를 가리키지 않는다.
  - 배포 모드에서는 `#<n>` 이다.
- **판정.** `import { createStore } from "supa-store"` 뒤에 `createStore.ofContext(…)` 만 쓰는 파일을 `isDefinition` 이 참으로 본다.
- **묶음.** `test:pack` 의 자원 정의를 `ofContext` 꼴로 바꿔 깨끗한 Vite 템플릿에서 `tsc -b && vite build` 가 통과한다.

### 3.8 버전

0.7.1 이다. 더하기만 하므로 깨지는 것이 없다.

### 3.9 소비자에게 따라오는 것

이 문서의 몫은 아니지만, 소비자가 옮길 때 알아야 할 것이 하나 있다. 호출 모양이 `createStore(…)` 가 아니라 `createStore.ofContext(…)` 이므로, 함수 이름(`callee.name`)으로 `createStore` 호출을 알아보는 lint 규칙은 이 모양도 보도록 고쳐야 한다. editor 의 「모듈 최상단에서만 등록한다」 · 「정의 파일만 등록한다」 규칙이 여기에 든다. editor 이관 설계가 이것을 맡는다.

## 4. 견준 길

**세 인자에 모두 타입을 적는다(0.7.0 그대로).** `(_s: unknown, _g: unknown, ctx: Ctx) =>` 로 쓰면 추론된다. 라이브러리를 바꾸지 않아도 된다. 대신 정의의 절반에 쓰지 않는 인자 둘과 타입 셋, `import type { Ctx }` 가 붙는다. 사용자가 불편으로 짚어 버렸다.

**같은 이름의 겹치기 선언.** `createStore` 에 `(ctx: Ctx) => S` 를 받는 선언을 겹친다. 2026-11-09 에 0.7 타입에 대고 두 차례를 모두 쟀다.

- `(ctx) => S` 를 먼저 두면 `(set) => …` 의 첫 인자를 `ctx` 로 읽는다.
- 뒤에 두면 `(ctx) => …` 의 첫 인자를 `set` 으로 읽는다. 바꾸려던 59 곳이 이 꼴이다.

인자 이름은 타입 검사에 아무 뜻이 없고 두 꼴 모두 인자가 하나라, 어느 차례로도 사람의 뜻대로 가를 수 없다. 게다가 먼저 대어 본 선언에서 인자 타입이 굳어 다음 선언으로 넘어가도 다시 정해지지 않는다(`implicitly has an 'any' type` 이 났다).

**첫 인자에 타입을 적는 겹치기 선언.** 사람이 `(ctx: Ctx) => …` 로 타입을 적으면 타입 검사로는 갈린다. 하지만 실행할 때 타입 표기가 사라져, 라이브러리가 첫 자리에 `set` 을 넘길지 `ctx` 를 넘길지 알 수 없다. `(set) => …` 와 `(ctx: Ctx) => …` 는 실행 시에 똑같이 인자 하나짜리 함수다. 깜빡하고 `: Ctx` 를 빼면 첫 인자가 `set` 으로 읽혀 엉뚱한 오류 문구가 난다.

**초깃값을 따로 받는 꼴(`createStore(initial, (set, get, ctx) => actions)`).** 인자 수로 가르므로 같은 이름으로 겹칠 수 있고 `(set, get, ctx)` · `(set, get)` · `(set)` 이 모두 추론된다(2026-11-09 잼). 하지만 다음 셋 때문에 버렸다.

- `ctx` 만 쓰는 자원에는 맞지 않는다. 자원은 초깃값이 따로 없다.
- 첫 자리가 언제나 `set` 이라, `(ctx) => …` 로 잘못 쓰면 `ctx(handle)` 이 `set(handle)` 로 오류 없이 지나간다.
- 덜어 줄 곳이 `set` 을 쓰는 9 곳뿐인데 그 9 곳은 지금 꼴로 추론된다.

**`createStore` 의 타입 기본값을 `never` 대신 `unknown`(또는 `object`)으로 둔다.** 사용자가 대화에서 내놓은 길이다. `unknown` 은 `S extends object` 제약을 지키지 않아 컴파일되지 않고, `object` 로 두면 컴파일은 된다. 하지만 그러면 타입을 깜빡한 정의가 `Store<object>` 가 되어 `set` 이 아무 객체나 받고, 오류가 정의 자리가 아니라 쓰는 자리에서 난다. 0.7 최종 검토가 바로 이 함정을 막으려고 기본값을 `never` 로 바꿨다. 타입을 사용자가 함께 주는 zustand 꼴(`createStore<Shape>(…)`)은 기본값과 상관없이 이미 된다.

**인자 차례를 `(ctx, set, get)` 으로 바꾼다.** `ctx` 의 타입 `Ctx<S>` 가 `S` 에 기대므로 순환이 그대로 남아 추론되지 않는다. 이미 쓴 모든 정의도 고쳐야 한다.

**다른 라이브러리.** 다른 store 에 기대는 정의를 Nanostores 는 `computed`, TanStack Store 는 `Derived`, Effector 는 `combine` 처럼 이름을 달리 둔다. Jotai 는 `atom` 하나로 두되 첫 인자가 값인지 함수인지로 가른다. supa-store 는 두 꼴의 첫 인자가 모두 함수라 이름을 달리 두는 쪽이다. 콜백 인자의 이름이나 수로 꼴을 가르는 라이브러리는 찾지 못했다.

## 5. 만드는 이에게 남긴 것

- `createStore` 에 메서드를 붙이는 방법(함수 선언과 이름 공간 병합, 또는 `Object.assign`)과 그 `.d.ts` 의 모양. 편집기의 정의로 가기가 `ofContext` 에서도 듣는 쪽으로 고른다
- §3.3 의 이름이 실제로 정의 파일을 가리키는지 확인하고, 아니면 `labelFromStack` 이 건너뛸 프레임을 넓히는 방법
- README 예시를 `ofContext` 로 고칠 자리 고르기
