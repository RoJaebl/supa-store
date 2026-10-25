# supa-store

key 로 상태를 정의하고, 정의에서 타입을 만들어 `useStore("key")` 로 꺼내는 작은 상태 라이브러리. 런타임 의존이 없다.

## 설치

```sh
npm i supa-store
```

`typescript >=5.4` 가 필요하다. `react >=18`, `vite`, `next` 는 쓰는 것만 있으면 된다.

## 시작 절차

두 줄이면 된다.

```ts
// vite.config.ts — 한 줄
import { supaStore } from "supa-store/vite";
export default defineConfig({ plugins: [react(), supaStore()] });
```

```ts
// src/main.tsx — 한 줄. 생성 파일이 정의 파일을 모두 import 해 등록을 일으킨다
import "./store.gen";
```

`store.config.ts` 는 없어도 된다. 기본값은 정의 `src/**/*.state.ts`, 생성 파일 `src/store.gen.ts` 이다.

## 정의와 꺼내기

정의는 `*.state.ts` 에 둔다. key 는 문자열 리터럴이어야 한다.

```ts
// src/count.state.ts
import { createStore } from "supa-store";
createStore("count", (set) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));
```

```tsx
// 컴포넌트 — pick 으로 고른 칸이 바뀔 때만 다시 그린다
import { useStore } from "supa-store/react";
const { n, inc } = useStore("count", { pick: ["n", "inc"] });
```

서버에서 받아 오는 값은 자원으로, store 사이의 알림은 event 로 정의한다.

```ts
import { createStore } from "supa-store";
import { createEvent, createResource } from "supa-store/query";

createStore("api.todos", () =>
  createResource(() => ({
    query: async () => (await fetch("/api/todos")).json() as Promise<string[]>,
    add: async (title: string) => void (await fetch("/api/todos", { method: "POST", body: title })),
  })),
);
// useStore("api.todos") → { data, status, error, refetch, add: { mutate, mutateAsync, pending, error, data, reset } }

createStore("event.saved", () => createEvent<{ id: string }>());
```

## 자원 더 쓰기

아래 예는 이 자원을 쓴다. 자원 정의의 둘째 인자에는 `auto` · `select` · `placeholderData` · `refetchInterval` 을 적는다. 뒤의 셋은 화면 옵션에도 같은 이름으로 있다.

```ts
createStore("api.file.dirLevel", () =>
  createResource(() => ({
    query: async (a: { repo: string; dir: string }) => (await fetch(`/api/${a.repo}/${a.dir}`)).json() as Promise<string[]>,
    save: async (name: string) => name.length,
  })),
);
```

### 여러 args 를 한 번에

`args` 에 값 하나를 주면 하나, 배열을 주면 같은 순서의 배열을 돌려준다. 목록으로 꺼낸 화면과 하나로 꺼낸 화면은 같은 값과 같은 요청을 나눠 갖는다.

```tsx
const one = useStore("api.file.dirLevel", { args: { repo, dir } });
const many = useStore("api.file.dirLevel", { args: dirs.map((dir) => ({ repo, dir })), pick: ["data", "status"] });
// many: { data, status }[] — 목록의 pick · omit 은 조회 칸(data · status · error · isPlaceholderData · refetch)만 고른다
```

`Cache`(`getData` · `invalidate` · `fetch` · `setData`)도 배열을 받는다. `invalidate([])` 는 아무것도 하지 않고, `invalidate()` 는 받아 둔 것 모두를 다시 받는다.
`fetch` 목록은 하나라도 실패하면 그 오류로 거절한다.

**자원의 `args` 는 배열이나 튜플 타입으로 짓지 않는다** — 생성기가 실패시킨다. 맨 배열을 목록으로 읽기 때문이다. 여러 값은 객체로 묶는다.

### 바꾸기: mutate 와 mutateAsync

둘 다 `pending` · `data` · `error` 를 똑같이 고친다. `mutate` 는 아무것도 돌려주지 않고 실패를 `error` 에만 둔다. `mutateAsync` 는 결과를 돌려주고 실패하면 원래 오류를 던진다.

```tsx
const { save } = useStore("api.file.dirLevel", { pick: ["save"] });
save.mutate("a");                          // 칸만 고친다
const n = await save.mutateAsync("a");     // 결과를 받고, 실패는 catch 로 받는다
```

바꾸기 이름은 `data` · `status` · `error` · `isPlaceholderData` · `refetch` · `fetch` · `getData` · `setData` · `invalidate` 와 겹칠 수 없다.

### 주기적으로 다시 받기

```ts
createResource(define, { refetchInterval: 60_000 });                  // 자원이 정한다
useStore("api.todos", { refetchInterval: 5_000 });                    // 자원이 정하지 않은 args 를 화면이 채운다
useStore("api.file.dirLevel", { args, refetchInterval: (a) => (a.dir === "" ? 10_000 : false) });
```

- 값은 `number | false | (args) => number | false | undefined`. 자원이 숫자를 정한 `args` 는 화면의 값을 보지 않는다. 자원이 정하지 않았으면 그 `args` 를 보는 화면들 가운데 가장 짧은 간격을 쓴다.
- 타이머는 `args` 하나에 하나다. 그 `args` 를 보는 화면이 있는 동안만 돌고, 받기가 끝난 때부터 간격을 센다.
- 창이 가려지면(`document.visibilityState === "hidden"`) 멈추고, 다시 보일 때 간격이 지났으면 곧바로 한 번 받는다.
- 실패하면 간격을 두 배씩 늘려 기본 간격의 8배까지 간다. 한 번 성공하면 기본 간격으로 돌아온다.
- 주기 받기도 받는 동안 `status` 를 `"loading"` 으로 바꾸고 `data` 는 그대로 둔다. `status` 에 스피너를 걸면 주기마다 깜박이므로 `data` 가 있는지로 가른다.
- 서버 렌더에서는 타이머를 걸지 않는다. `auto: false` 인 자원도 간격이 정해진 `args` 는 주기로 받는다.

### 자리 채우기

받은 값이 없는 동안(받는 중이거나 실패한 뒤) 보일 값을 정한다. 보이는 `data` 가 자리 채운 값이면 `isPlaceholderData` 가 `true` 다. 자리 채운 값은 그 화면에만 보인다.

```tsx
import { keepPreviousData } from "supa-store/query";

useStore("api.file.dirLevel", { args: { repo, dir }, placeholderData: [] });                        // 지어낸 값
useStore("api.file.dirLevel", { args: { repo, dir }, placeholderData: keepPreviousData });           // 바로 전 값을 잇는다
useStore("api.file.dirLevel", { args: { repo, dir }, placeholderData: keepPreviousData((a, p) => p.args.repo === a.repo) });
useStore("api.file.dirLevel", { args: { repo, dir }, placeholderData: (a, prev) => prev[0]?.data });  // 직접 짓는다
```

- **`keepPreviousData` 는 그대로 `placeholderData` 에 넘기거나 `keepPreviousData(match)` 로 쓴다.** `(a, p) => keepPreviousData(a, p)` 로 감싸면 목록 꼴의 동작을 잃는다.
- 그대로 넘기면 하나 꼴에서는 바로 전 값을 잇고, 목록 꼴에서는 같은 `args` 의 앞 값만 잇는다. 항목이 끼어들어도 옆 항목의 값이 밀려오지 않는다.
- 자원의 것을 먼저 구하고, 정하지 않았으면(`undefined`) 화면의 것을 쓴다.
- 인라인 함수여도 된다. `useCallback` 이 필요 없다.

### 바꾸어 꺼내기(select)

```ts
createResource(define, { select: (data, args) => data.map((t) => t.title) });       // 캐시는 그대로, 화면에 줄 때만 바꾼다
useStore("api.todos", { select: (titles) => titles.length });                         // 자원 select 의 결과를 이어 받는다
```

- 자원의 `select` 는 `getData` · `setData` · `fetch` 의 모양을 바꾸지 않는다. 화면의 `select` 는 자원 `select` 의 결과를 이어 받는다.
- 자리 채운 값에도 `select` 를 거친다. 목록 꼴에서는 항목마다 불린다.
- 바꾼 결과를 바로 전과 겉 한 겹(`Object.is`)으로 견주어 같으면 다시 그리지 않는다. **깊이 견주지 않으므로, 새 응답마다 새 배열이나 새 객체를 안에 담아 돌려주면 응답마다 다시 그린다.** 필요한 값만 돌려준다.
- `select` · `placeholderData` 를 렌더마다 새 함수로 적어도 된다.

### React Query 에서 옮겨 올 때

| React Query | supa-store |
|---|---|
| `useQuery` | `useStore(key, { args })` |
| `useQueries` | `useStore(key, { args: [...] })` |
| `useMutation` 의 `mutate` · `mutateAsync` | 같은 이름. `useStore(key)` 에서 바꾸기 이름으로 꺼낸다 |
| `refetchInterval` | 같은 이름(자원 또는 화면) |
| `placeholderData` · `keepPreviousData` | 같은 이름 |
| `select` | 같은 이름(자원 또는 화면) |
| `setQueryData` · `getQueryData` | `getData(args)` · `setData(updater, args)` |
| `invalidateQueries` | `invalidate(args)`, 다른 자원이 바뀔 때는 event 의 `on` |
| `onMutate` 낙관적 갱신 · `useInfiniteQuery` | 바꾸기 함수 안에서 `getData` · `setData` |

```ts
import type { Cache } from "supa-store/query";

// 캐시를 직접 읽고 쓴다 — store 안에서는 ctx, 밖에서는 getStore
ctx("api.settings").getData();
ctx("api.settings").setData((prev) => ({ ...prev!, theme: "dark" }));

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
      cache.setData(() => prev);
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
createStore("api.graph", (set, get, ctx) => {
  const graph = createResource(() => ({ query: fetchGraph }));
  ctx("event.repo.changed").on(ctx.key, () => void graph.invalidate());
  return graph;
});
```

### 0.1.0 에서 옮길 때

- `mutate` 는 이제 결과를 돌려주지 않는다. `await x.mutate(...)` 의 결과를 쓰던 코드는 `mutateAsync` 로 바꾼다.
- `args` 를 배열 타입으로 지은 자원은 생성기가 실패시킨다. 객체로 묶는다.
- `QueryView` 에 `isPlaceholderData` 칸이 늘었다. 정의 파일은 고치지 않아도 된다.

## 생성 파일

- 생성 파일은 TypeScript 타입이라 `tsc` 가 읽는다. 템플릿의 `build` 는 `tsc -b && vite build` 로 `tsc` 가 Vite 보다 먼저 돌므로, `tsc` 가 돌 때 생성 파일이 디스크에 있어야 한다. Tailwind 처럼 Vite 안에서만 짓는 꼴로는 안 되는 까닭이 이것이다(Tailwind 의 결과는 CSS 라 `tsc` 가 보지 않는다).
- **생성 파일은 커밋한다.** 편집기 플러그인(tsserver)과 Vite 개발 서버가 정의를 고칠 때마다 다시 쓰므로 저장소의 파일은 거의 늘 최신이다. TanStack Router 의 `routeTree.gen.ts` 와 같은 꼴이다.
- 커밋된 파일이 낡는 경우는 하나다 — 편집기 플러그인 없이 정의를 쓰고 개발 서버도 띄우지 않은 채 곧바로 빌드할 때. 그런 흐름과, 생성 파일을 커밋하지 않는 프로젝트는 `"build": "store-gen && tsc -b && vite build"` 처럼 빌드 앞에 `store-gen` 을 둔다.

## 편집기에서 타입 따라오게 하기

선택 단계다. 이 단계 없이도 빌드·시험·개발 서버는 동작한다. 편집기의 타입만 생성 파일이 다시 써질 때 따라온다.

- tsconfig `compilerOptions.plugins` 에 `{ "name": "supa-store/plugin" }` 를 더하고, VS Code 에서 작업 공간 TypeScript 를 쓴다.
- **모노레포라면 루트 `package.json` 의 devDependencies 에도 `supa-store` 를 둔다.** tsserver 는 플러그인을 tsconfig 폴더가 아니라 TypeScript 가 놓인 자리에서 찾으므로 루트 `node_modules` 에 있어야 한다.
- Vite react-ts 템플릿은 루트 `tsconfig.json` 이 `files: []` 와 references 뿐이므로, 플러그인 항목은 `tsconfig.app.json` 의 `compilerOptions.plugins` 에 넣는다.

## Next.js 와 그 밖의 도구

Next 는 `next.config` 를 `withStore` 로 감싼다.

```js
// next.config.mjs
import { withStore } from "supa-store/next";
export default withStore({});
```

Vite 도 Next 도 아니면 `npx store-gen` 으로 생성 파일을 한 번 쓴다.

## 라이선스

MIT
