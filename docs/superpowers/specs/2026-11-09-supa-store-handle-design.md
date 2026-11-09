# supa-store 0.7 — store 를 key 가 아니라 `createStore` 가 돌려주는 핸들로 가리킨다

- 날짜: 2026-11-09
- 바탕: 0.6.0(`dev` `b7283f0`). 이 문서가 고치지 않은 것은 그대로 둔다
- 브랜치: `store-handle+`
- 소비자: editor(supa-store `b7283f0` 에 묶여 있다)와 fortuna-lottery(supa-store `026389c` 에 묶여 있다). 둘의 이관은 이 문서의 몫이 아니다. editor 의 이관 설계는 editor 저장소가 따로 쓴다

## 1. 의도와 까닭

**store 를 쓰는 자리에서 그 store 가 어디서 정의되었는지 따라갈 수 있어야 한다.**

0.6 은 store 를 문자열 key 로 가리킨다. `useStore("action.workspace.CommitPanel.getDetail")` 이나
`ctx("event.workspace.CommitPanel.commitsCreated")` 의 key 는 그냥 문자열이라, 편집기의 정의로 가기와 참조 찾기가 듣지 않는다.
정의 자리를 찾으려면 문자열을 grep 해야 한다. 이것이 이번 변경의 까닭이다. 사용자가 이 문제를 직접 짚었다.

key 방식은 이 결함을 메우려고 장치 셋을 따로 지고 있다.

- **생성기**(`tools/codegen.cjs` 와 그것을 부르는 Vite 플러그인 · Next 감싸기 · CLI `store-gen` · tsserver 플러그인).
  정의 파일을 모두 side-effect import 하는 생성 파일을 쓰고, key 마다 상태 타입을 붙이는 `StateTypes` 보강을 쓴다.
- **설정 파일**(`supa-store/config` 의 `defineConfig`). 생성기가 어느 파일을 정의로 볼지 고른다.
- **key 문자열을 보는 lint 규칙.** 소비자가 각자 지고 있다(editor 는 일곱).

**핸들로 바꾸면 셋이 모두 필요 없어진다.** 정의 파일을 import 하는 순간 store 가 등록되고, `createStore` 의 반환 타입이 상태 타입을
나른다. 그래서 import 줄이 곧 출처가 된다.

## 2. 목표 · 하지 않는 것 · 실패로 치는 것

**목표.**

- `createStore(creator)` 가 핸들을 돌려주고, store 를 받는 모든 API 가 핸들을 받는다.
- 생성기 · 설정 파일 · tsserver 플러그인 · CLI 를 걷는다.
- 개발 서버에서 정의 파일을 고치면 페이지 전체를 다시 읽는다. Vite 와 Next 둘 다.
- event 를 잇는 쪽이 이름을 적지 않는다. 짓는 동안 건 듣기는 그 store 를 버릴 때 라이브러리가 뗀다.
- 오류 메시지와 event 기록에는 store 를 알아볼 이름이 선다. 사람이 그 이름을 쓰지 않는다.

**하지 않는 것.**

- **정의 파일을 고친 뒤 store 상태를 지키지 않는다.** 0.6 의 개발 모드 재등록(같은 key 로 다시 등록하면 정의를 갈아 끼우고 다시 짓는다)을
  걷는다. 핸들 방식에서 상태를 지키려면 옛 핸들과 새 핸들을 이을 신원이 필요하다. 그 신원을 손으로 쓴 이름에서 얻으면 이번에 걷는 문자열이
  되살아나고, 플러그인이 변환으로 넣어 주면 그 변환을 지금 지어야 한다. 사용자가 페이지 다시 읽기를 받아들였다(§4 갈래 1).
- **key 와 핸들을 함께 받는 중간 버전을 두지 않는다.** 0.7 은 key API 를 통째로 걷는다(§4).
- **이름으로 store 를 찾는 API 를 두지 않는다.** §3.5 의 이름은 메시지와 기록에만 쓴다.

**실패로 치는 것.**

- 정의 파일을 고친 뒤 페이지를 다시 읽지 않고 갱신이 받아져, 옛 store 와 새 store 가 함께 살아 있는 것. 옛 store 가 event 에 건 듣기가 남아
  사건 하나에 같은 일이 두 번 돈다. 화면은 맞게 보이므로 오래 숨는다.
- store 를 버린 뒤에도 그 store 가 짓는 동안 건 듣기가 event 에 남는 것.
- 핸들을 쓰는 자리가 정의 자리를 import 하지 않고도 store 에 닿는 길이 남는 것. 그러면 §1 의 까닭이 되돌아온다.

## 3. 정한 것

### 3.1 `createStore` 와 핸들

```ts
export const count = createStore((set, get, ctx) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));
// count: Store<{ n: number; inc: () => void }>
```

- `createStore(creator)` 는 핸들 `Store<S>` 를 돌려준다. `S` 는 creator 의 반환 타입이다.
- **핸들은 store 를 가리키는 표지일 뿐이다.** 상태 타입을 나르고 store 를 가리키는 일만 한다. 읽고 쓰는 메서드를 갖지 않는다.
- **React 밖에서 읽고 쓰는 길은 0.6 처럼 `getStore` 다.** `getStore(handle)` 이 0.6 의 `StoreApi<S>`(`getState` · `getInitialState` ·
  `setState` · `subscribe`)를 돌려준다. `getStore("k").getState()` 는 `getStore(k).getState()` 가 된다. 짓는 것은 여전히 처음 꺼낼 때다.
  0.6 문서가 약속한 「다시 지어도 같은 객체다」는 그대로다. `overrideStore` · `resetStores` · `disposeStores` 가 다시 지어도 `getStore(handle)`
  은 같은 객체를 준다.
- **핸들을 `StoreApi` 로 두지 않은 까닭.** creator 안에서 다른 store 를 `ctx` 가 아닌 길로 읽으면 기댐(`deps`)도 계산 공간의 읽기도 적히지
  않는다. 그러면 `overrideStore` 뒤에 다시 지어지지 않고, 파생이 다시 계산하지 않아 오류 없이 낡은 값을 낸다. 우회하는 자리가 언제나
  `getStore(…)` 호출이면 소비자의 lint 가 함수 이름으로 「creator 안에서 `getStore` 를 부르지 않는다」를 잡을 수 있다. 핸들이 `StoreApi` 이면
  우회가 `x.getState()` 라는 평범한 메서드 호출이 되어, 타입을 읽지 않는 lint 로는 잡지 못한다(사용자가 이 꼴을 골랐다. §4 견준 길).
- `set` · `get` 의 타입은 creator 의 반환 타입에서 온다. creator 안에서 `set` 의 타입이 자기 반환 타입에 기대는 순환은 TypeScript 가 추론으로
  풀지 못할 수 있다. 그때는 `createStore<Shape>(…)` 처럼 타입 인자를 적는다. 어느 꼴이 추론되고 어느 꼴이 적어야 하는지는 만드는 이가
  시험으로 확인하고 README 에 적는다.
- **모듈 최상단에서만 부른다.** 함수 안에서 부르면 부를 때마다 새 store 가 생긴다. 라이브러리는 이것을 막지 않는다. 소비자의 lint 가 막는다.

### 3.2 핸들을 받는 API

| API | 0.6 | 0.7 |
|---|---|---|
| 화면에서 꺼내기 | `useStore(key, …)` | `useStore(handle, …)`. 갈래(`USE` 가 있으면 맡기고, 없으면 `pick` · `omit`)와 반환 타입 규칙은 그대로고, 타입을 key 대신 핸들의 상태 타입에서 끌어낸다 |
| store 끼리 읽기 | `ctx(key, { pick \| omit })` | `ctx(handle, { pick \| omit })`. 짓는 동안 기댐을 적는 것, 계산 공간에서 `noteRead`, 파생이면 `.get()` 을 주는 것이 그대로다 |
| 자기 자신 | `ctx()` | 그대로 |
| React 밖에서 읽고 쓰기 | `getStore(key)` | `getStore(handle)`. 돌려주는 `StoreApi` 는 그대로 |
| 정의 갈아 끼우기 | `overrideStore(key, creator)` | `overrideStore(handle, creator)` |
| 등록된 것 전부 | `registeredKeys(): string[]` | `registeredStores(): Store<unknown>[]` — 등록한 차례대로 |
| 짓는 store 의 이름 | `ctx.key` | 걷는다(§3.4) |

- **`registeredStores()` 는 앱 전체에 거는 일에 쓴다.** 예를 들어 서버와 다시 이어졌을 때 모든 자원을 낡게 하는 일이다(editor 의 `storeBridge`
  가 지금 `registeredKeys()` 로 한다). 0.6 주석의 「출력 스냅숏이 쓴다」는 낡은 말이라 고친다. 이 API 는 어느 한 store 를 찾는 길이 아니다.
  핸들에 이름이 없으므로 목록에서 특정 store 를 골라낼 수 없고, 고를 수 있는 것은 상태의 모양(`invalidate` 가 있는가 같은)뿐이다. 그래서
  §2 가 실패로 친 「정의 자리를 import 하지 않고 store 에 닿는 길」에 들지 않는다고 본다(설계자의 판단).
- `StateTypes` · `StateKey` · `StateOf` · `PublicKey` 와 key 로 타입을 끌어내던 보조 타입을 모두 걷고, 핸들의 상태 타입에서 끌어내는
  꼴로 바꾼다. `Names` · `PickOptions` · `Picked` · `ReadOf` 는 key 대신 상태 타입을 받는다.
- **닫힌 key(`_` 로 시작하는 key 는 `useStore` 로 꺼내지 못한다)를 걷는다.** 핸들 방식에서 닫는 것은 export 하지 않거나, 모듈 밖으로 다시
  내보내지 않는 것이다. 어디까지 열지는 소비자의 import 경계가 정한다. README 의 「닫힌 key」 절은 그 꼴로 고쳐 쓴다.

### 3.3 등록과 기댐

- registry 는 문자열 `Map` 이 아니라 등록한 차례를 지키는 entry 목록이다. 핸들에서 entry 로 가는 길은 라이브러리 안에만 둔다.
- `deps` 는 key 대신 entry 를 담는다. `rebuild` 가 기댐을 거슬러 올라가는 방식은 그대로다.
- 순환 검사(`building` 사슬)도 entry 로 잇는다. 오류 문구의 사슬은 §3.5 의 이름으로 찍는다.
- **0.6 의 개발 모드 재등록 갈래를 걷는다.** `createStore` 는 언제나 새 entry 를 만든다. 같은 store 가 두 번 등록되는 일은 그 모듈이 다시
  돌 때뿐이다. 개발 서버에서는 §3.6 이 페이지 다시 읽기로 그것을 막는다.
- **시험이 모듈을 다시 읽는 경우는 막지 않는다.** `vi.resetModules()` 뒤에 정의 파일을 다시 import 하면 새 entry 가 따로 생기고, 옛 entry 와
  그것이 event 에 건 듣기가 남는다. 0.6 에서는 같은 key 의 재등록이 정의를 갈아 끼워 이 꼴이 통했다. editor 시험 셋이 여기에 기댄다
  (`history.action.test.ts` 등). 0.7 은 이 경우를 감지하지 않는다. 감지하려면 옛 모듈과 새 모듈을 잇는 신원이 필요하고, 그것은 §4 갈래 1이
  뺀 장치다. README 에 「시험에서 정의를 바꾸려면 모듈을 다시 읽지 말고 `overrideStore` 를 쓴다」를 적고, 그 시험들을 옮기는 일은 소비자의
  이관이 맡는다(설계자의 판단).
- 0.6 의 「같은 key 를 두 번 등록했다」 오류는 key 가 없으므로 사라진다.
- **import 순환.** 정의 파일끼리 서로 import 해도 된다. creator 는 처음 꺼낼 때 돌므로, 그때는 두 모듈이 모두 평가를 마쳤다. 모듈 평가 중에
  다른 store 를 꺼내면(최상단에서 `x.getState()`) 순환 안에서 아직 평가되지 않은 핸들을 만날 수 있다. README 에 「모듈 최상단에서 store 를
  꺼내지 않는다」를 적는다.

### 3.4 event 를 잇는 쪽은 이름을 적지 않는다

0.6 에서는 짓는 공간에서 `ctx("event.x").on(ctx.key, fn)` 처럼 듣는 쪽의 이름을 적었다. 같은 이름이 다시 걸면 앞 것을 갈아 끼우므로,
다시 지을 때 듣기가 겹치지 않았다. 0.7 에서는 그 일을 라이브러리가 한다.

```ts
export const saved = createStore(() => createEvent<{ id: string }>());

export const todos = createStore((_set, _get, ctx) => {
  ctx(saved).on(({ id }) => { /* … */ });
  ctx(saved).exempt("목록이 스스로 다시 받는다"); // 또는 이렇게 일부러 듣지 않음을 남긴다
  return createResource(() => ({ query: fetchTodos }));
});
```

- `on(fn)` · `exempt(why)` 는 「누가」를 받지 않는다. **짓는 공간에서 부르면 지금 짓고 있는 store 가 누구다.** 라이브러리가 짓는 사슬
  (`building`)의 맨 끝을 읽는다.
- 짓는 공간에서 건 듣기는 그 store 의 entry 가 기억한다. **그 store 를 버릴 때(`dispose`) 라이브러리가 뗀다.** `rebuild` · `overrideStore` ·
  `resetStores` · `disposeStores` 가 모두 `dispose` 를 거치므로 어느 길로 다시 짓든 듣기가 겹치지 않는다. 떼는 일은 상태의 `[DISPOSE]` 를
  부른 뒤에 한다. `[DISPOSE]` 가 던져도 뗀다.
- **짓는 공간 밖에서 부른 `on(fn)`** 은 누구도 아닌 듣기로 걸리고, 0.6 처럼 풀기 함수를 돌려준다. 라이브러리가 떼지 않는다.
- **짓는 공간 밖에서 부른 `exempt(why)`** 는 오류다. 일부러 듣지 않는다는 결정은 store 의 정의에 속하기 때문이다.
- 같은 store 가 같은 event 에 `on` 과 `exempt` 를 함께 적으면 0.6 처럼 오류다. 같은 store 가 같은 event 에 `on` 을 둘 거는 것은 허용한다.
  두 듣기가 모두 돈다. 0.6 의 「갈아 끼우기」는 다시 짓기에서 겹침을 막던 장치였고, 그 일은 이제 `dispose` 가 한다.
- `record()` 는 0.6 과 같은 모양(`{ on: string[]; exempt: { who; why }[] }`)이고, `who` 는 §3.5 의 이름이다. 누구도 아닌 듣기는 `on` 목록에
  넣지 않는다.
- `ctx.key` 를 걷는다. 0.6 문서가 밝힌 쓸모는 「event 에 누가를 남길 때」 하나였다.

### 3.5 이름: 부른 자리에서 얻는다

오류 메시지와 `record()` 는 store 를 알아볼 이름이 있어야 읽힌다. 0.6 에서는 key 가 그 일을 했다. 0.7 은 사람이 이름을 쓰지 않고
`createStore` 를 부른 자리에서 얻는다.

- 개발 모드와 시험(`process.env.NODE_ENV !== "production"`)에서는 `createStore` 가 `new Error().stack` 을 읽어 **supa-store 바깥의 첫 프레임**
  을 이름으로 적는다. 꼴은 `<경로>:<줄>` 이다. 예: `src/app/(workspace)/CommitPanel/_action/commitDetail/commitDetail.action.ts:12`.
- 경로는 사람이 읽기 좋게 다듬는다. 번들러가 붙인 앞머리와 뒤꼬리를 뗀다. 적어도 Vite 개발 서버의 `http://<host>/` 와 `?t=…` · `?v=…`,
  webpack 의 `webpack-internal:///` 와 `(app-pages-browser)/` 꼴, `file://` 를 뗀다. 열의 번호는 뗀다.
- stack 을 읽지 못하거나 프레임을 가려내지 못하면, 그리고 배포 빌드에서는 등록 차례로 `#<n>` 을 쓴다. 이름은 늘 비어 있지 않다.
- **이 이름으로 store 를 찾는 API 는 두지 않는다.** 핸들에 이름을 내보이는 칸도 두지 않는다. 쓰는 곳은 오류 문구와 `record()` 둘뿐이다.
- 이름은 정의 자리와 어긋날 수 없다. 사람이 쓰지 않았기 때문이다. 대신 줄 번호는 그 파일을 고치면 바뀐다. 시험이 `record()` 를 견줄 때는
  이름을 문자열로 박지 말고 수나 포함 여부로 견주라고 README 에 적는다.

0.6 오류 문구 가운데 key 를 찍던 것은 이 이름을 찍는다. 「등록되지 않은 key 다」는 핸들이 곧 등록이므로 사라진다.

### 3.6 정의 파일을 고치면 페이지 전체를 다시 읽는다

**Vite 나 Next 의 갱신에 맡기면 안 된다.** 고친 정의 파일을 presenter 나 컴포넌트 모듈이 import 하면 갱신이 그 길로 React Fast Refresh
경계까지 올라가 받아진다. 그러면 정의 모듈이 다시 돌아 새 핸들과 새 entry 가 생기고, 옛 entry 는 버려지지 않은 채 남는다. 옛 entry 가
event 에 건 듣기도 남는다. §2 가 실패로 친 그 상태다.

그래서 라이브러리의 번들러 장치가 정의 파일의 변경을 가로채 페이지 전체를 다시 읽게 한다.

- **정의 파일을 가리는 법.** 파일 안에 `supa-store` 에서 가져온 `createStore` 를 부르는 자리가 있는가로 가린다. 설정 파일의 `include` 를 쓰지
  않는다(§3.7 에서 걷는다). 정규식으로 충분한지, 가볍게 파싱해야 하는지는 만드는 이가 정한다. 놓치는 쪽(정의 파일인데 못 알아봄)이 더
  위험하다. 넘치는 쪽(정의가 아닌데 다시 읽음)은 다시 읽기가 한 번 늘 뿐이다.
- **정의 파일이 import 하는 모듈을 고쳐도 다시 읽는다.** Vite 는 고친 모듈에서 import 한 쪽으로 경계까지 거슬러 올라가며 그 길의 모듈을
  모두 다시 실행한다. 그래서 정의 파일이 import 하는 api 모듈이나 util 을 고치면 정의 파일은 그대로인데도 정의 모듈이 다시 돈다. 따라서 판정은
  「바뀐 모듈이 정의 파일인가」가 아니라 **「바뀐 모듈이나 그것을 거슬러 import 한 모듈 가운데 정의 파일이 있는가」** 다. 경계 너머의 정의
  파일까지 세어 다시 읽기가 조금 넘칠 수 있으나, 넘치는 쪽은 위에서 말했듯 덜 위험하다. 정의 파일이 기대는 모듈을 고칠 때마다 페이지를
  다시 읽게 되는 것은 갈래 1을 고른 값이다(설계자의 판단. §4 갈래 1).
- **Vite** — `supa-store/vite` 의 `supaStore()` 는 생성 대신 이 일만 한다. 개발 서버에서 위 판정이 참이면 `full-reload` 를 보내고 그
  갱신의 모듈 목록을 비워 Fast Refresh 로 가지 않게 한다. 거슬러 올라가는 것은 Vite 의 모듈 그래프(import 한 쪽 목록)로 한다. 지금 Vite(8)에서 이 일을 맡는 훅(`hotUpdate` · `handleHotUpdate`)은 만드는 이가
  고른다. 빌드와 vitest 에서는 아무것도 하지 않는다.
- **Next** — `supa-store/next` 의 `withStore(nextConfig)` 는 생성 대신 이 일만 한다. 개발 모드에서 정의 파일에 갱신을 받지 않는다는 표시를
  넣는다. webpack 이면 loader 로 `import.meta.webpackHot?.decline()` 을 덧붙이는 꼴이 후보다. 받지 않은 갱신은 webpack 이 전체 다시
  읽기로 처리한다. webpack 은 갱신이 올라가는 길에서 받지 않는 모듈을 만나면 멈추므로, 정의 파일이 기대는 모듈을 고친 경우도 같은 표시로
  막힌다. 만드는 이가 시험으로 확인한다. **Turbopack(`next dev --turbopack`)에서 같은 일이 되는지는 확인하지 않았다.** 만드는 이가 확인하고, 되지 않으면 README 에
  「Turbopack 개발 서버에서는 정의 파일을 고친 뒤 직접 새로 고친다」를 적는다. fortuna-lottery 가 Next 15 를 쓴다.
- **번들러 장치를 걸지 않은 소비자.** 0.7 은 생성 파일이 없으므로 장치 없이도 빌드 · 시험 · 개발 서버가 돈다. 다만 정의 파일을 고친 뒤 갱신이
  받아질 수 있다. README 의 시작 절차에 장치를 거는 것을 필수 단계로 적고, 걸지 않으면 무엇이 일어나는지 한 줄로 밝힌다.
- **presenter 나 컴포넌트를 고칠 때는 지금처럼 Fast Refresh 가 돈다.** 정의 모듈은 다시 돌지 않으므로 핸들이 그대로고 store 도 그대로다.

### 3.7 걷는 것

- `tools/codegen.cjs` · `codegen-worker.cjs` · `cli.mjs` · `plugin.cjs` 와 그 시험, `plugin/` 폴더
- `package.json` 의 `bin`(`store-gen`)과 `exports` 의 `./config` · `./plugin`, `files` 의 해당 항목
- `src/config.ts`(`defineConfig` · `StoreConfig` · `StoreTarget`)
- `vite.mjs` · `next.mjs` 의 생성 · 감시 · worker 부분(§3.6 의 일로 다시 쓴다)
- `peerDependencies` 의 `typescript` — 생성기와 tsserver 플러그인 말고 쓰는 곳이 없으면 걷는다. 만드는 이가 확인한다
- README 의 「생성 파일」 · 「편집기에서 타입 따라오게 하기」 절, 시작 절차의 생성 단계

### 3.8 버전과 옮기는 길

- 버전은 **0.7.0** 이다. 1.0 전이므로 깨지는 변경을 둘째 자리에서 올린다. 0.5 · 0.6 도 그렇게 올렸다.
- README 에 「0.6 에서 옮길 때」 절을 더한다. 0.4 · 0.1.0 절과 같은 꼴로, 아래를 옛 꼴과 새 꼴의 짝으로 적는다.
  - `createStore("k", creator)` 에서 `export const k = createStore(creator)` 로
  - `useStore("k", …)` · `ctx("k", …)` · `getStore("k")` · `overrideStore("k", …)` 에서 핸들로
  - `.on(ctx.key, fn)` 에서 `.on(fn)` 으로, `.exempt(ctx.key, why)` 에서 `.exempt(why)` 로
  - `registeredKeys()` 에서 `registeredStores()` 로
  - 생성 파일 · 설정 파일 · tsserver 플러그인 항목 · `store-gen` 지우기, 번들러 장치는 남기기
  - 닫힌 key 는 export 경계로
- 소비자 둘은 지금 커밋에 묶여 있으므로 0.7 이 dev 에 올라가도 깨지지 않는다. 각자 옮길 때 핀을 올린다.

### 3.9 시험

`pnpm test`(빌드 · vitest · node 시험)와 `pnpm test:pack` 이 통과해야 한다. 그 밖에 아래를 시험으로 박는다.

- `getStore(handle)` 이 다시 지어도 같은 객체를 주고 구독이 살아남는다(`overrideStore` · `resetStores` · `disposeStores` 뒤).
- `ctx(handle)` 로 기댄 store 가 기댄 store 의 `overrideStore` 뒤 다시 지어진다.
- 짓는 동안 건 `on(fn)` 이 `overrideStore` · `resetStores` · `disposeStores` 뒤 하나만 남는다. 사건 하나에 한 번 돈다.
- `[DISPOSE]` 가 던져도 짓는 동안 건 듣기가 떨어진다.
- 짓는 공간 밖의 `exempt(why)` 가 오류를 낸다. 짓는 공간 밖의 `on(fn)` 은 풀기 함수로만 떨어진다.
- 순환 오류 문구에 두 store 의 이름이 `<경로>:<줄>` 꼴로 선다. 배포 모드에서는 `#<n>` 꼴이다.
- `record()` 의 `who` 가 부른 자리의 이름이다.
- `useStore(handle)` 의 타입이 0.6 의 key 꼴과 같은 결과를 낸다. `USE` 갈래(자원 · 스트림 · 파생) · `pick` · `omit` 를 타입 시험(`tsconfig.test.json`)
  으로 잰다.
- Vite 장치: 개발 서버에서 정의 파일이 바뀌면 `full-reload` 를 보내고, 정의가 아닌 파일은 지나 보낸다. 빌드 모드에서는 아무것도 하지 않는다.
- Next 장치: 개발 모드의 webpack 설정에 정의 파일만 고르는 규칙이 서고, 다른 모드에서는 서지 않는다.
- `test:pack`: 깨끗한 Vite 템플릿에서 생성 단계 없이 `tsc -b && vite build` 가 통과한다.

## 4. 견준 길

**정의 파일을 고친 뒤 store 를 어떻게 하는가.** 사용자가 갈래 1을 골랐다.

- **갈래 1: 페이지 전체를 다시 읽는다(고른 것).** 신원 장치가 필요 없다. 라이브러리가 가장 단순해진다. 고칠 때마다 메모리 상태를 잃는다.
- **갈래 2: 손으로 쓴 이름으로 신원을 잇는다.** `createStore("name", creator)`. 상태를 지키지만 이름 문자열이 되살아난다. 개발 모드에서는 이름
  겹침과 다시 읽기를 구별할 수 없어, 겹친 이름이 오류 없이 서로를 덮어쓴다. 이름으로 찾는 API 가 다시 생기기도 쉽다.
- **갈래 3: 번들러가 변환으로 신원을 넣는다.** 사람이 쓰는 꼴은 갈래 1과 같고 상태를 지킨다. 변환을 지어야 하고, 변환 없이 도는 환경에서는
  갈래 1로 떨어진다. **사람이 쓰는 API 가 갈래 1과 같으므로 나중에 라이브러리 안에서만 더할 수 있다.** 갈래 1을 고른 까닭 가운데 하나다.
- 신원 없이 갱신을 받는 길은 견줄 대상에서 뺐다. 옛 store 가 버려지지 않아 듣기가 겹친다.

**React 밖에서 읽고 쓰는 길을 어떤 모양으로 두는가.** 사용자가 `getStore(handle)` 을 골랐다.

- **`getStore(handle)`(고른 것).** 핸들은 표지이고 기능은 `getStore` 가 준다. creator 안에서 `ctx` 를 우회하는 자리가 함수 이름으로 드러나
  lint 로 막을 수 있다. 소비자의 자리마다 바뀌는 것은 인자 하나다.
- **핸들이 곧 `StoreApi`.** API 가 `getStore` 하나만큼 작다. 대신 `ctx` 우회가 `x.getState()` 로 숨어 타입을 읽는 lint 가 있어야 막는다.

**어떻게 옮기는가.** 사용자가 한 번에 옮기기를 골랐다.

- **한 번에(고른 것).** 0.7 이 key API 를 통째로 걷는다. 라이브러리에 갈래가 하나뿐이다.
- **나누어.** 중간 버전이 key 와 핸들을 둘 다 받는다. 옮기는 동안 생성기와 lint 를 남겨야 하고, registry 가 두 꼴의 entry 사이 기댐을 다뤄야
  한다. 그 코드는 이관이 끝나면 버린다.

**메시지와 기록의 이름을 어디서 얻는가.** 사용자가 부른 자리를 골랐다.

- **부른 자리(고른 것).** 사람이 쓰지 않으므로 어긋나지 않고, 번들러 없이 돈다. 줄 번호는 파일을 고치면 바뀐다.
- **이름 없이.** 순환 오류가 어느 store 들이 도는지 말하지 못하고, `record()` 가 수만 낸다.
- 손으로 쓰는 표시용 이름은 갈래 2의 문자열이, 번들러가 넣는 이름은 갈래 3의 변환이 되살아나므로 뺐다.

## 5. 만드는 이에게 남긴 것

- 핸들의 상태 타입 추론이 어디까지 되는지와 README 의 타입 인자 안내(§3.1)
- 정의 파일을 가리는 판정의 구현(§3.6)
- Vite 의 훅 선택, Next 의 webpack 표시 방법과 Turbopack 확인(§3.6)
- stack 에서 supa-store 바깥의 첫 프레임을 가리는 방법과 경로 다듬기의 세부(§3.5)
- `peerDependencies` 의 `typescript` 를 걷을 수 있는지(§3.7)
- README 의 예시를 모두 핸들 꼴로 고쳐 쓰기. 예시가 파일 하나에 store 여럿을 두면 export 이름을 짓는다
