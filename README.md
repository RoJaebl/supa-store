# supa-store

key 로 상태를 정의하고, 정의에서 타입을 만들어 `useStore("key")` 로 꺼내는 작은 상태 라이브러리. 런타임 의존이 없다.

## 설치

```sh
npm i supa-store
```

`typescript >=5.4` 가 필요하다. `react >=18`, `vite`, `next` 는 쓰는 것만 있으면 된다.

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

커밋을 바꿀 때는 두 자리의 `<커밋>` 을 함께 바꾼다. npm 판이 나오면 `"supa-store": "^0.4.0"` 으로 바꾸고 `allowBuilds` 줄은 지운다.

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
// many: { data, status }[] — 목록의 pick · omit 은 조회 칸(data · status · error · isPlaceholderData · isFetching · refetch)만 고른다
```

`Cache`(`getData` · `invalidate` · `fetch` · `setData`)도 배열을 받는다. `invalidate([])` 는 아무것도 하지 않고, `invalidate()` 는 받아 둔 것 모두를, `invalidate((a) => a.repo === "A")` 는 참인 칸을 고른다.
고른 칸 가운데 화면이 보는 칸만 곧바로 다시 받고(`await` 는 이것만 기다린다), 보지 않는 칸은 값을 두고 낡음만 표시한다 — 화면이 다시 보거나 `fetch` 하면 그때 받고, `getData` 는 쥔 값을 준다.
그래서 query 의 args 는 함수로 짓지 않는다(생성기가 막는다). 받는 중인 칸은 보지 않아도 곧바로 다시 받는다.
앞 판에서 옮길 때: 화면 없이 새 값이 필요하면 `invalidate` 뒤 `getData` 가 아니라 `fetch` 를 쓴다 — 보지 않는 칸은 무효화가 곧바로 다시 받지 않는다.
`fetch` 목록은 하나라도 실패하면 그 오류로 거절한다.

**자원의 `args` 는 배열이나 튜플 타입으로 짓지 않는다** — 생성기가 실패시킨다. 맨 배열을 목록으로 읽기 때문이다. 여러 값은 객체로 묶는다.

### 바꾸기: mutate 와 mutateAsync

둘 다 `pending` · `data` · `error` 를 똑같이 고친다. `mutate` 는 아무것도 돌려주지 않고 실패를 `error` 에만 둔다. `mutateAsync` 는 결과를 돌려주고 실패하면 원래 오류를 던진다.

```tsx
const { save } = useStore("api.file.dirLevel", { pick: ["save"] });
save.mutate("a");                          // 칸만 고친다
const n = await save.mutateAsync("a");     // 결과를 받고, 실패는 catch 로 받는다
```

바꾸기 이름은 `data` · `status` · `error` · `isPlaceholderData` · `isFetching` · `refetch` · `fetch` · `getData` · `setData` · `invalidate` 와 겹칠 수 없다.

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
- 받은 값이 있는 `args` 를 다시 받는 동안(주기 받기 · `refetch` · `invalidate`) `status` 는 그대로다 — `ready` 는 `ready`, 실패한 뒤면 `error`. `"loading"` 은 받은 값이 없을 때뿐이다. 새로 고치는 표시는 요청이 진행 중이면 `true` 인 `isFetching` 에 건다.
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
createStore("api.graph", (set, get, ctx) => {
  const graph = createResource(() => ({ query: fetchGraph }));
  ctx("event.repo.changed").on(ctx.key, () => void graph.invalidate());
  return graph;
});
```

### 0.1.0 에서 옮길 때

- `mutate` 는 이제 결과를 돌려주지 않는다. `await x.mutate(...)` 의 결과를 쓰던 코드는 `mutateAsync` 로 바꾼다.
- `args` 를 배열 타입으로 지은 자원은 생성기가 실패시킨다. 객체로 묶는다.
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

createStore("infra.terminal", () =>
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
const { data, status, isFetching, error, open } = useStore("infra.terminal", { pick: ["data", "status", "isFetching", "error", "open"] });
await open.mutateAsync("/repo"); // 실패하면 던진다
```

연결의 칸(`data` · `status` · `isFetching` · `error`)과 명령마다의 칸(`mutate` · `mutateAsync` · `pending` · `error` · `data` · `reset` · `retry`)이 있다.
다른 store 에서는 `getStore("infra.terminal").getState().open("/repo")` 처럼 명령 함수로 부르고, 실패하면 던진다.

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

createStore("infra.lsp", (set, get, ctx) =>
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
createStore("editor.complete", (set, get, ctx) => ({
  run: (p: CompletionParams) => ctx("infra.lsp").complete(p),
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

store 꼴은 서버 전용 설정 · 등록부에서만 쓴다. `store-gen` 의 생성 파일이 모든 정의 파일을 import 하므로, 화면과 같은 등록부에 두면
`child_process` 가 브라우저 묶음에 들어간다. 그런 프로젝트는 위의 바로 쓰는 꼴을 쓴다.

## 생성 파일

- 생성 파일은 TypeScript 타입이라 `tsc` 가 읽는다. 템플릿의 `build` 는 `tsc -b && vite build` 로 `tsc` 가 Vite 보다 먼저 돌므로, `tsc` 가 돌 때 생성 파일이 디스크에 있어야 한다. Tailwind 처럼 Vite 안에서만 짓는 꼴로는 안 되는 까닭이 이것이다(Tailwind 의 결과는 CSS 라 `tsc` 가 보지 않는다).
- **생성 파일은 커밋한다.** 편집기 플러그인(tsserver)과 Vite 개발 서버가 정의를 고칠 때마다 다시 쓰므로 저장소의 파일은 거의 늘 최신이다. TanStack Router 의 `routeTree.gen.ts` 와 같은 꼴이다.
- 커밋된 파일이 낡는 경우는 하나다 — 편집기 플러그인 없이 정의를 쓰고 개발 서버도 띄우지 않은 채 곧바로 빌드할 때. 그런 흐름과, 생성 파일을 커밋하지 않는 프로젝트는 `"build": "store-gen && tsc -b && vite build"` 처럼 빌드 앞에 `store-gen` 을 둔다.
- 생성 타입에 `any` 가 남으면 생성이 멈춘다. 다만 `createStore("x", (set, get, ctx): Shape => …)` 처럼 반환 타입을 적은 정의는 이 검사를 건너뛴다 — `React.ReactElement` 처럼 라이브러리 기본 타입 인자의 `any` 를 쓸 때 반환 타입을 적는다. 반환 타입을 적으면 표기 안의 `any` 와 풀리지 않은 타입(import 오타, 타입 인자 오류 등)도 막지 않으므로, 정의 파일의 `tsc` 오류를 먼저 고친다.

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
