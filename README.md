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
// useStore("api.todos") → { data, status, error, refetch, add: { mutate, pending, error, data, reset } }

createStore("event.saved", () => createEvent<{ id: string }>());
```

## 생성 파일

- 생성 파일은 TypeScript 타입이라 `tsc` 가 읽는다. 템플릿의 `build` 는 `tsc -b && vite build` 로 `tsc` 가 Vite 보다 먼저 돌므로, `tsc` 가 돌 때 생성 파일이 디스크에 있어야 한다. Tailwind 처럼 Vite 안에서만 짓는 꼴로는 안 되는 까닭이 이것이다(Tailwind 의 결과는 CSS 라 `tsc` 가 보지 않는다).
- **생성 파일은 커밋한다.** 편집기 플러그인(tsserver)과 Vite 개발 서버가 정의를 고칠 때마다 다시 쓰므로 저장소의 파일은 거의 늘 최신이다. TanStack Router 의 `routeTree.gen.ts` 와 같은 꼴이다.
- 커밋된 파일이 낡는 경우는 하나다 — 편집기 플러그인 없이 정의를 쓰고 개발 서버도 띄우지 않은 채 곧바로 빌드할 때. 그런 흐름과, 생성 파일을 커밋하지 않는 프로젝트는 `"build": "store-gen && tsc -b && vite build"` 처럼 빌드 앞에 `store-gen` 을 둔다.

## 편집기에서 타입 따라오게 하기

선택 단계다. 이 단계 없이도 빌드·시험·개발 서버는 동작한다. 편집기의 타입만 생성 파일이 다시 써질 때 따라온다.

- tsconfig `compilerOptions.plugins` 에 `{ "name": "supa-store/plugin" }` 를 더하고, VS Code 에서 작업 공간 TypeScript 를 쓴다.
- **모노레포라면 루트 `package.json` 의 devDependencies 에도 `supa-store` 를 둔다.** tsserver 는 플러그인을 tsconfig 폴더가 아니라 TypeScript 가 놓인 자리에서 찾으므로 루트 `node_modules` 에 있어야 한다.

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
