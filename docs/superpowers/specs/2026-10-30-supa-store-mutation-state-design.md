# supa-store 0.5 — 바꾸기의 상태를 자원이 쥐고, `select` 가 그것을 따라간다

- 날짜: 2026-10-30
- 상태: **승인됨(2026-10-30, 사람이 editor 세션에서 「이대로 승인」 — §9 의 여섯 판단 포함. 겉 이름은 `inflight` 로 두고 안쪽 `Cell.inflight` 를 바꾼다)**
- 계기: editor 의 store 정의를 「요청 하나가 key 하나」로 가르는 작업에서, 설정을 고치는 바꾸기(`patchSettings`)와 설정을 받는
  자원(`getSettings`)이 다른 key 로 갈라졌다. 응답 전에 바뀐 값을 보이는 겹(낙관적 표시)을 받는 쪽 정의 안에서 `ctx` 만으로
  짓고 싶었는데, 지금 버전은 그 길을 주지 않는다. 이 문서는 editor 세션에서 사람과 나눈 대화를 정리한 것이다.

## 1. 의도와 까닭

바꾸기를 보내 놓고 응답이 오기 전에도 화면이 바뀐 값을 보이게 한다. **그 값을 캐시에 미리 쓰지 않는다.** 캐시에는 서버가 준
값만 들어가고, 응답 전의 값은 화면에 줄 때 얹는 겹으로만 산다. 그래서 실패하면 겹이 빠지면서 저절로 원래 값으로 돌아가고,
되돌리는 코드가 필요 없다.

지금 버전으로는 이것을 지을 수 없다. 까닭이 둘이다.

- **바꾸기 상태가 화면 안에만 있다.** `pending` · `error` · `data` 는 `mutate` 를 부른 화면의 `React.useState` 에 있고
  (`src/resourceHook.ts` 의 `useMutation`, 「바꾸기 하나의 화면별 상태」), 보내는 중인 인자는 어디에도 남지 않는다. 다른 화면도
  다른 store 도 「무엇을 보내는 중인가」를 알 수 없다.
- **`select` 는 자기 캐시가 바뀔 때만 다시 돈다.** 화면 훅은 자기 캐시 칸만 구독하고, 캐시 값이 그대로면 `select` 를 건너뛴다
  (`src/resourceHook.ts`, 「받은 값과 화면 select 가 그대로면 앞 결과를 쓴다」). `select` 안에서 `ctx` 로 다른 store 를 읽어도
  그것이 바뀐 것을 알아채지 못한다. 0.2 설계 §3 이 「store 끼리의 구독」을 하지 않는 것으로 둔 자리다.

### event 와 다르다

이 기능은 event 와 겉모습이 비슷하지만 하는 일이 다르다.

- **event** 는 서비스 안팎에 「무엇이 바뀌었다」는 사실을 알린다. 내는 쪽은 누가 듣는지 모르고, 받는 쪽이 여럿이어도 하나도
  없어도 된다.
- **이 기능** 은 관계가 정해진 store 끼리 서로의 **지금 상태** 를 읽는다. 읽는 쪽이 자기 정의 안에 그 관계를 적고, 알림은
  오가지 않는다. 범위가 event 보다 작다.

### key 를 어떻게 가를지는 쓰는 사람의 몫이다

editor 는 「요청 하나가 key 하나」로 가르지만 그것은 editor 의 규칙이다. supa-store 에서는 한 key 의 자원이 받기 하나와
바꾸기 여럿을 함께 가져도 되고, 바꾸기 하나만 가져도 된다. **이 버전이 더하는 것은 모두 바꾸기 이름 하나를 단위로 하므로 두
꼴을 똑같이 받는다.**

## 2. 정한 것

### 2.1 바꾸기의 상태를 자원이 쥔다

`createResource` 가 바꾸기 이름마다 상태 칸 하나를 쥔다.

| 칸 | 담는 것 |
|---|---|
| `inflight` (가칭) | 보냈지만 응답이 아직 오지 않은 호출들의 인자. 원소 하나가 호출 하나이고 원소는 그 호출의 인자 배열이다. 보낸 차례대로 선다 |
| `pending` | `inflight.length > 0` |
| `error` | 마지막으로 끝난 호출이 실패했으면 화면에 보일 문구, 아니면 `null` |
| `data` | 마지막으로 끝난 호출이 성공했으면 그 결과 |

- 같은 key 를 꺼낸 **모든 화면과 store 가 같은 값을 본다.**
- 칸이 바뀔 때마다 새 객체 · 새 배열로 갈아 끼우고 그 칸을 구독한 쪽에 알린다.
- **`reset()` 도 자원으로 옮긴다.** 그 바꾸기의 `error` · `data` 를 지우고, 같은 key 를 꺼낸 모든 화면이 알림을 받는다.
  `inflight` 는 지우지 않는다 — 보내는 중인 요청은 `reset` 과 상관없이 끝까지 간다.

**호출 번호는 라이브러리 안에서만 쓴다.** 끝난 호출을 `inflight` 에서 정확히 빼는 데와 늦은 응답을 가리는 데(§2.4)에 쓴다. 같은
인자를 두 번 보내면 인자로는 어느 쪽이 끝났는지 가릴 수 없기 때문이다. 타입에도 화면에도 드러나지 않는다.

**읽는 길은 둘이다.**

```ts
// 화면 — 지금처럼 꺼낸다. 어느 화면에서 꺼내든 같은 값이다
const { patch } = useStore('api.workspace.patchSettings', { pick: ['patch'] })
patch.mutate({ accent: 'red' })
patch.inflight   // [[{ accent: 'red' }]]

// store — 바꾸기 함수는 지금처럼 부르는 함수로 남고, 상태 칸을 읽기 전용 속성으로 단다
ctx('api.workspace.patchSettings').patch(p)          // 지금처럼 부른다(0.2 설계 §9)
ctx('api.workspace.patchSettings').patch.inflight    // 새로 읽는다
```

`mutate` · `mutateAsync` 는 지금처럼 화면이 `useStore` 로 꺼낼 때만 생긴다. store 에서 함수를 바로 부르는 호출도 상태 칸을
거친다 — 「store 에서 부른 호출은 겹에 보이지 않는다」는 갈림을 만들지 않는다.

### 2.2 `select` 가 읽은 바꾸기 상태를 따라간다

- `select` 가 돌아가는 동안 **바꾸기 상태 칸의 속성을 읽으면** 라이브러리가 그 칸을 적어 둔다. 적는 것은 `ctx` 를 부르는
  순간이 아니라 속성을 읽는 순간이다. 그래서 어느 key 에서 꺼냈는지는 보지 않는다.
- 화면 훅은 자기 캐시 칸에 더해 적힌 칸들도 구독한다. 다음에 돌 때 읽은 칸이 달라지면 구독도 그에 맞춘다.
- 건너뛰는 조건을 넓힌다. **캐시 값과 적힌 칸이 모두 그대로일 때만** 앞 결과를 쓴다.
- 적는 것은 `select` 가 돌아가는 동안뿐이다. 화면의 이벤트 처리 · 바꾸기 함수 · event 를 받는 쪽에서 읽는 것은 적지 않는다.

이것은 **정의를 다시 짓지 않는다.** 정의 함수는 지금처럼 처음 꺼낼 때 한 번 돌고, 다시 짓기는 정의가 바뀔 때(Fast Refresh ·
`overrideStore` · `resetStores`)만 일어난다. 다시 도는 것은 `select` 하나이고, 캐시도 그대로이며 서버 요청도 나가지 않는다.

**한 단계에서 멈춘다.** `ctx` 가 주는 것은 상대 store 의 원래 상태이고 상대의 `select` 결과가 아니다(`select` 는 화면 훅 안에서만
돈다). 그래서 A 의 `select` 가 B 를 읽고 B 의 `select` 가 C 를 읽어도 C 가 바뀔 때 다시 도는 것은 B 의 `select` 뿐이다. 바꾸기
상태는 `select` 의 결과에 기대지 않으므로 두 store 가 서로를 읽어도 고리가 생기지 않는다.

`select` 안에서는 읽기만 한다.

### 2.3 `ctx()` — 인자 없이 부르면 자기 자신

```ts
select: (s) => {
  const self = ctx()                 // ctx(ctx.key) 와 같다
  return self.patch.inflight.reduce((acc, [p]) => acc.with(p), s)
}
```

- **짓는 동안에는 부를 수 없다.** 정의 함수가 처음 도는 동안에는 자기 상태가 아직 없다. 지금은 이 경우가 `순환한다: …` 로
  막히는데 원인이 드러나지 않으므로 `짓는 동안에는 자기 자신을 꺼낼 수 없다: <key>` 로 막는다. `select` · `onSuccess` 들 ·
  바꾸기 함수 · event 를 받는 쪽은 모두 짓기가 끝난 뒤에 돌므로 언제나 쓸 수 있다.
- **`pick` 은 받지 않는다.** 골라 꺼내야 하면 `ctx(ctx.key, { pick })` 을 쓴다. `ctx({ pick })` 처럼 첫 인자의 뜻이 바뀌는 꼴은
  만들지 않는다.
- **타입.** `Ctx` 에 자기 key 를 타입 인자로 단다. `createStore<K>` 의 creator 가 받는 `ctx` 는 `Ctx<K>` 다.

  ```ts
  interface Ctx<Self extends StateKey = StateKey> {
    (): StateOf<Self>;
    <K extends StateKey>(key: K): StateOf<K>;
    <K extends StateKey, N extends Names<K>, O extends PickOptions<K, N>>(key: K, options: O): Picked<K, O>;
    readonly key: Self;
  }
  ```

### 2.4 결과 처리와 호출 순서 — `onSuccess` · `onError` · `onSettled` · `scope`

`createResource` 옵션에 바꾸기 이름을 열쇠로 적는다. 이름과 뜻은 TanStack Query 를 따른다 — 새 이름을 짓지 않는다.

```ts
{
  onSuccess?: { [name]?: (result, ...args) => void },
  onError?:   { [name]?: (error, ...args) => void },
  onSettled?: { [name]?: (result, error, ...args) => void },
  scope?:     { [name]?: { id: string } },
}
```

**결과를 다른 곳에 넘기는 일(`emit` · `setData`)은 바꾸기 함수 안이 아니라 `onSuccess` 에 적는다.** 함수 안에서 `emit` 하면
라이브러리가 그 호출이 늦은 응답인지 가리기 전에 이미 일어나 버린다.

**동시에 보내는 것이 기본이다.** TanStack 과 같다.

- 동시에 보내다가 더 나중에 보낸 호출이 먼저 끝났으면, 앞 호출의 응답은 **늦은 응답** 이다. 늦은 응답은 `data` · `error` 를
  고치지 않고 `onSuccess` · `onError` · `onSettled` 를 부르지 않는다. 그 호출의 `mutateAsync` 는 자기 결과로 끝난다(지금 화면별
  상태와 같다).
- 이 거르기는 서버가 받은 차례대로 처리하는 경우에 맞다. 그렇지 않을 수 있으면 `scope` 를 쓴다.

**`scope: { [name]: { id } }` 를 적으면 같은 `id` 의 바꾸기가 한 줄에 서서 차례대로 나간다.**

- `id` 는 key 와 상관없는 문자열이다. 같은 key 의 두 바꾸기든 다른 key 의 바꾸기든 같은 `id` 면 한 줄에 선다. 서버의 같은 값을
  고치는 바꾸기가 여러 key 로 갈라져 있을 때 이것으로 묶는다.
- 줄에서 기다리는 호출의 인자도 `inflight` 에 들어간다. 그래서 겹은 기다리는 동안에도 보인다.
- 한 줄 안에서는 늦은 응답이 생기지 않는다.

**호출 하나의 차례**

1. 호출 번호와 인자를 `inflight` 에 넣고 알린다. `scope` 가 있으면 줄 차례가 올 때까지 기다린다.
2. 바꾸기 함수를 부른다.
3. 늦은 응답인지 견준다.
4. 늦지 않았으면 `data` 또는 `error` 를 적고 `onSuccess` 또는 `onError`, 그다음 `onSettled` 를 부른다.
5. **그 뒤에** 그 호출을 `inflight` 에서 빼고 알린다.

4 가 5 보다 앞서야 한다. 그래야 성공했을 때 캐시가 먼저 서버 값이 되고 그다음에 겹이 빠져서, 그 사이에 옛 값이 한 번 그려지는
일이 없다. 콜백이 던지면 그 오류는 `mutateAsync` 로 던지지 않고 콘솔에 남긴 뒤 5 로 간다 — 콜백의 실패가 `inflight` 를 붙잡지
않게 한다.

**최종 표시는 서버 데이터다.** 겹은 응답 전의 임시 표시이고 캐시에 쓰지 않는다. 모든 호출이 끝나 `inflight` 가 비면 화면의 값은
캐시의 값, 곧 서버가 준 값이다.

## 3. 쓰는 모습

### 받기와 바꾸기가 한 key 에 있을 때

```ts
createStore('api.workspace.appearance', (_set, _get, ctx) =>
  createResource(() => ({
    query: fetchAppearance,
    async patch(p: AppearancePatch) { return readAppearance(await http.patch('/api/appearance', p)) },
    async patchIcons(p: IconPatch) { return readAppearance(await http.patch('/api/appearance/icons', p)) },
  }), {
    scope: { patch: { id: 'settings' }, patchIcons: { id: 'settings' } },
    onSuccess: {
      patch: (next) => ctx().setData(next),
      patchIcons: (next) => ctx().setData(next),
    },
    select: (s) => {
      const self = ctx()
      return [...self.patch.inflight, ...self.patchIcons.inflight].reduce((acc, [p]) => acc.with(p), s)
    },
  }),
)
```

### 받기와 바꾸기가 다른 key 에 있을 때

```ts
createStore('event.workspace.settingsPatched', () => createEvent<{ settings: Settings }>())

createStore('api.workspace.patchSettings', (_set, _get, ctx) =>
  createResource(() => ({
    async patch(p: SettingsPatch) { return readSettings(await http.patch('/api/settings', p)) },
  }), {
    scope: { patch: { id: 'settings' } },
    onSuccess: { patch: (settings) => ctx('event.workspace.settingsPatched').emit({ settings }) },
  }),
)

createStore('api.workspace.getSettings', (_set, _get, ctx) => {
  const settings = createResource(() => ({ query: fetchSettings }), {
    select: (s) => ctx('api.workspace.patchSettings').patch.inflight.reduce((acc, [p]) => acc.with(p), s),
  })
  ctx('event.workspace.settingsPatched').on(ctx.key, ({ settings: next }) => settings.setData(next))
  return settings
})
```

두 꼴 모두 화면은 `useStore('api.workspace.getSettings')` 로 꺼내기만 한다. 겹이 있다는 것을 몰라도 된다.

| 때 | `patch.inflight` | `getSettings` 의 캐시 | 화면 |
|---|---|---|---|
| 고르기 전 | `[]` | 파랑 | 파랑 |
| 빨강을 고른 직후 | `[[{ accent: 'red' }]]` | 파랑 | 빨강 — `select` 가 겹을 얹는다 |
| 서버가 성공을 준 뒤 | `onSuccess` 로 캐시가 빨강이 된 뒤 `[]` | 빨강 | 빨강 |
| 서버가 실패를 준 뒤 | `[]` | 파랑 | 파랑 — 겹이 빠지며 돌아간다 |

## 4. 고려한 길

- **바꾸기 안에서 캐시를 먼저 고치고 실패하면 되돌린다(지금 README 의 낙관적 갱신).** 지금도 되고 이 버전에서도 남긴다. 다만
  받기와 바꾸기가 다른 key 에 있으면 바꾸기가 남의 캐시를 고쳐야 한다. 받는 쪽이 자기 정의 안에서 관계를 적는 이 버전의 길이
  그것을 대신한다.
- **바꾸기 상태가 바뀌면 그것을 읽은 store 를 다시 짓는다.** 다시 지으면 자원이 새로 생겨 캐시가 비고 서버에 다시 묻는다.
  `select` 만 다시 돌리는 쪽으로 갔다.
- **줄 세우기를 기본으로 한다.** 겹을 얹는 바꾸기는 대개 같은 값을 고치므로 안전한 기본값이 될 수 있었다. TanStack 과 같은 기본
  (동시에 보내기)을 따르고 줄은 `scope` 로 고르게 했다.
- **동시에 보낼 때 늦은 응답을 겹친 호출이 모두 끝난 뒤 다시 받아 덮는다.** 바꾸기만 가진 자원은 무엇을 다시 받을지 모른다. 그
  대상은 받는 쪽만 안다.
- **`select` 의 둘째 인자로 자기 바꾸기 상태를 넘긴다.** 읽는 길이 둘이 된다. `ctx()` 하나로 자기와 남을 같은 길로 읽게 했다.

## 5. 하지 않는 것

- **다른 store 의 캐시 값을 따라가지 않는다.** `select` 안에서 `ctx(key).getData()` 를 읽을 수는 있지만 부르는 순간의 값만 준다.
  겹에는 바꾸기 상태만 있으면 된다. 쓰임새가 생기면 같은 방식(`getData` 가 읽은 칸을 적는다)으로 넓힌다.
- **호출 번호를 겉으로 내보이지 않는다.**
- **`select` 안에서 쓰기를 허락하지 않는다.**
- **연결 명령의 화면별 상태(`src/stream/hook.ts` 의 `useMutation`)는 그대로 둔다.** 스트림 연결은 화면이 쥔 연결의 명령이라 자원이
  없다.

## 6. 깨지는 것과 판 번호

0.4 에서 0.5 로 올린다.

- **바꾸기 상태가 화면 사이에 나뉜다.** 두 화면이 같은 key 의 바꾸기를 꺼내면 지금은 서로의 `pending` · `error` 를 보지 못하지만
  이제는 함께 본다. 한 화면의 `reset` 이 다른 화면의 `error` 도 지운다.
- **늦은 응답을 가리는 단위가 화면에서 자원의 바꾸기 이름으로 넓어진다.** 지금은 같은 화면에서 뒤 요청이 앞 요청을 넘어설 때만
  버린다. 이제는 어느 화면 · 어느 store 에서 불렀든 같은 바꾸기 이름의 뒤 호출이 앞 호출을 넘어서면 버린다.

## 7. 스펙 문서와 README 에서 고칠 자리

- 0.2 설계 §3 「store 끼리의 구독」: `select` 안에서 바꾸기 상태를 읽는 것만은 따라간다고 범위를 좁혀 적는다.
- 0.2 설계 §9: `mutate` · `mutateAsync` 는 지금처럼 화면에서만 생기지만 바꾸기 상태는 store 에서도 읽힌다는 문장을 더한다.
- README: 낙관적 갱신 예시 옆에 `inflight` 겹 예시를 더한다. 지금의 `setData` 방식은 남긴다. TanStack 과 이름은 같지만 동작이
  다른 점 — **supa-store 의 콜백은 늦은 응답에서 부르지 않는다** — 을 적는다.

## 8. 시험

- 두 화면이 같은 바꾸기 상태(`inflight` · `pending` · `error` · `data`)를 보고, 한 화면의 `reset` 을 다른 화면도 받는다.
- `ctx(key).patch(p)` 로 store 에서 부른 호출도 `inflight` 에 보인다.
- 성공하면 `onSuccess` 가 캐시를 고친 뒤에 `inflight` 가 빈다 — 그 사이에 옛 값이 한 번도 그려지지 않는다.
- 실패하면 겹이 빠지고 원래 값으로 돌아간다. 캐시는 한 번도 바뀌지 않는다.
- `inflight` 가 바뀌어 `select` 가 다시 돌아도 서버 요청이 나가지 않고 정의 함수도 다시 돌지 않는다.
- `select` 가 `patch` 만 읽으면 `patchIcons` 가 바뀌어도 다시 돌지 않는다.
- 동시에 보낸 두 호출에서 앞 호출의 응답이 늦게 오면 `data` · `error` 를 고치지 않고 콜백을 부르지 않으며, 그 `mutateAsync` 는
  자기 결과로 끝난다.
- 같은 `scope.id` 의 바꾸기는 key 가 달라도 차례대로 나가고, 기다리는 호출의 인자도 `inflight` 에 있다.
- 두 store 가 `select` 에서 서로를 읽어도 끝없이 다시 돌지 않는다.
- 짓는 동안 `ctx()` 를 부르면 `짓는 동안에는 자기 자신을 꺼낼 수 없다: <key>` 로 실패한다.
- 콜백이 던져도 `inflight` 에서 빠진다.
- **타입 시험:** `ctx()` 가 자기 key 의 상태 타입을 돌려준다. `patch.inflight` 의 원소가 바꾸기 함수의 `Parameters` 다. `onSuccess`
  의 `result` 가 바꾸기 함수의 `Awaited<ReturnType>` 이다. 없는 바꾸기 이름을 `onSuccess` · `scope` 의 열쇠로 적으면 타입 오류다.

## 9. Claude 가 정한 것 — 사람이 확인할 것

대화에서 정하지 않아 Claude 가 채운 것이다.

1. **늦은 응답에서 `onError` · `onSettled` 도 부르지 않는다.** 대화는 `onSuccess` 만 정했다. 셋이 같은 규칙을 따르는 편이 헷갈리지
   않는다고 보았다.
2. **`reset` 은 차례를 올린다.** 그래서 `reset` 앞에 떠난 호출의 결과는 `data` · `error` 를 다시 채우지 않는다. 지금 화면별 `reset`
   과 같은 동작이다. `inflight` 에서는 그 호출이 끝날 때 빠진다.
3. **콜백이 던지면 콘솔에 남기고 삼킨다(§2.4).** 콜백의 실패가 겹을 붙잡거나 `mutateAsync` 의 결과를 바꾸지 않게 했다.
4. **store 에서 바로 부른 호출도 상태 칸을 거친다(§2.1).** 지금 0.2 설계 §9 는 store 의 호출이 칸을 거치지 않는다고 적는다. 겹이
   어디서 부른 호출이든 보여야 하므로 바꾸었다. 실패는 지금처럼 그대로 던져진다.
5. **연결 명령의 화면별 상태는 그대로 둔다(§5).**
6. **이름 `inflight` 는 안쪽의 같은 이름과 겹친다.** `src/query.ts` 의 칸(`Cell`)이 진행 중인 받기 요청의 Promise 를
   `inflight` 로 쥔다. 겉에 드러나는 이름이 아니라 안쪽 이름이므로 구현에서 안쪽 이름을 바꾸는 쪽을 권한다. 겉 이름을 다른 말
   (TanStack `useMutationState` 의 `variables`)로 할지는 사람이 정한다.

## 10. 빌더에게 맡기는 것

- 바꾸기 상태 칸을 쥐는 자료 구조와, 화면 훅이 읽은 칸의 구독을 바꿔 다는 방법.
- 줄(`scope`)을 자원 밖 어디에 둘지(모듈 안의 `id` → 줄 표).
- 읽기 전용 속성을 바꾸기 함수에 다는 방법(`Object.defineProperty` 등).
