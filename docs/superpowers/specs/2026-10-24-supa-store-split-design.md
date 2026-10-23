# supa-store 0.1.0 — fortuna 의 store 를 떼어 내 공개 npm 으로 낸다

- 날짜: 2026-10-24
- 자리: 승인 뒤 새 저장소 `C:/Users/hnpark/Documents/Project/supa-store` 의 `docs/superpowers/specs/` 로 옮겨 커밋한다
  (지금은 저장소가 없어 세션 공유 폴더에 둔다)
- 앞선 설계: `C:/Users/hnpark/Documents/Project/fortuna-lottery/docs/superpowers/specs/2026-10-21-state-library-design.md`(1단계),
  같은 폴더 `2026-10-22-store-stage2-design.md`(2단계)
- 다음 설계: React Query 를 대신할 기능 여덟(editor 의 요구) — 이 판이 나간 뒤 곧바로 따로 쓴다

## 1. 의도

fortuna-lottery 는 화면 상태를 `packages/store`(`@fortuna-lottery/store`)로 지었다. key 로 등록하는 전역 store, 자원·event,
생성기가 글자로 쓰는 타입이다. editor(저장소 그래프 뷰어)의 화면 앱도 vault 골조로 옮기면서 같은 라이브러리를 쓰기로 했다.
두 저장소가 한 라이브러리를 함께 받으려면 라이브러리가 어느 한 저장소의 워크스페이스 안에 있으면 안 된다. 그래서 별도
저장소로 떼어 내 공개 npm 패키지 `supa-store` 로 낸다.

이 판은 **지금 있는 것을 그대로** 떼어 낸다. 더하는 것은 셋뿐이다. 패키지 이름 바꾸기, Vite 생성 플러그인 `/vite`, 그리고
설치한 프로젝트가 곧바로 쓸 수 있게 하는 배포 묶음과 그 시험이다.

## 2. 목표

1. 공개 npm 에 `supa-store@0.1.0` 이 있다. scope 없는 이름이다(2026-10-24 기준 비어 있다).
2. 빈 Vite + React 프로젝트가 `supa-store` 를 설치하고 §7 시작 절차의 두 줄만 적으면 정의를 쓰고, 타입 검사·빌드·렌더가 통과한다.
   이것은 배포 묶음(`npm pack` 결과)으로 시험한다.
3. Vite 개발 서버에서 정의 파일을 더하거나 지우거나 고치면 생성 파일이 다시 써진다.
4. fortuna-lottery 가 워크스페이스 패키지 대신 npm 의 `supa-store` 를 쓰고, `pnpm check`(시험·타입 검사·lint)가 그대로 통과한다.
5. 런타임·자원·event·생성기의 동작은 바뀌지 않는다. 지금의 시험이 이름만 바뀐 채 모두 통과한다.

## 3. 하지 않는 것

- **ESLint 규칙을 내지 않는다.** 패키지는 eslint 없이 완전히 동작한다. fortuna 의 store 규칙 일곱은 fortuna 가 자기 코드를
  일정한 꼴로 쓰려고 둔 장치이고, 폴더 배치는 프로젝트마다 다르다(사용자 결정). supa-store 저장소의 lint 는 자기 소스만 본다.
- 폴더→key 규칙을 config 로 받지 않는다. 위와 같은 까닭이다.
- HTTP 클라이언트(서버 본문의 `{ error }` 문구를 살리는 것)를 넣지 않는다. 쓰는 쪽 코드다.
- React Query 를 대신할 기능 여덟을 넣지 않는다. 다음 판의 설계가 다룬다.
- editor 저장소를 건드리지 않는다.

## 4. 실패로 보는 것

- 배포된 묶음을 설치한 프로젝트가 README 에 없는 단계를 밟아야 동작한다.
- 이름을 바꾼 뒤 fortuna 의 lint 규칙이 오류 없이 아무것도 잡지 않는다. 그 규칙들은 import 출처를 글자로 대조하므로 출처를 함께
  바꾸지 않으면 조용히 꺼진다. §11 fortuna 를 옮기는 걸음 이 이것을 막는다.
- Vite 개발 서버에서 정의 파일을 더했는데 생성 파일이 따라오지 않아 `등록되지 않은 key 다` 가 난다.

## 5. 고려한 길 — 저장소를 어떻게 떼어 내는가

1. **이력째 떼어 낸다(고른 길).** fortuna 에서 `git subtree split --prefix packages/store` 로 store 의 커밋(지금 23개)만 뽑아
   새 저장소의 시작으로 삼는다. 줄마다의 `git blame` 이 fortuna 시절의 까닭으로 이어진다.
2. 이력 없이 복사한다. 단순하지만 첫 커밋이 1,700줄 한 덩어리가 되고 까닭은 fortuna 이력을 따로 뒤져야 한다.
3. fortuna 모노레포 안에서 그대로 배포한다. 별도 저장소로 내기로 정했으므로 뺐다.

1 은 Claude 가 정했다. 사용자는 이 물음이 패키지의 쓰임새와 상관이 없다는 것을 확인했고 판단을 넘겼다.
설계 문서 둘은 fortuna 에 그대로 두고 새 저장소에서 절대 경로로 가리킨다. 그 문서들이 fortuna 의 화면 앱 변경도 함께 적고 있기 때문이다.

## 6. 패키지의 모양

### 6.1 하위 경로

| 하위 경로 | 무엇을 내는가 | 어디서 부르는가 |
|---|---|---|
| `supa-store` | `createStore`·`getStore`·`overrideStore`·`resetStores`·`registeredKeys`·`pickFrom`·`USE` 와 타입 | 정의 파일·시험 |
| `supa-store/react` | `useStore` | presenter |
| `supa-store/query` | `createResource`·`createEvent` 와 타입 | 정의 파일 |
| `supa-store/config` | `defineConfig`·`StoreConfig` | `store.config.ts` |
| `supa-store/vite` | `supaStore()` Vite 플러그인 — 새로 더한다 | `vite.config.ts` |
| `supa-store/next` | `withStore` | `next.config.ts` |
| `supa-store/plugin` | tsserver 플러그인 | tsconfig 의 `plugins` |
| bin `store-gen` | CLI | 스크립트·시험 준비 |

지금 있는 `./tools/plugin.cjs` 하위 경로는 지운다. fortuna 의 tsconfig 가 그 이름을 쓰는데, 옮길 때 `supa-store/plugin` 으로 바꾼다.

### 6.2 이름이 박힌 자리

아래를 모두 `supa-store` 로 바꾼다. 이 목록이 빠짐없는지는 바꾼 뒤 저장소 전체에서 `fortuna` 를 찾아 0 건인지로 판정한다.

- 생성기 `render` 의 머리글 「자동 생성 — … 가 쓴다」 와 `declare module "…"`.
- `readUserConfig` 가 가로채는 `"…/config"`.
- `Symbol.for` 키 셋: `USE`(`"fortuna-lottery.store.use"`), `withStore` 의 감시 표식, tsserver 플러그인의 원본 표식.
  새 키는 `"supa-store.use"`·`"supa-store/watching"`·`"supa-store/original"` 이다. 한 페이지에 두 판이 함께 실리면 `USE` 키가
  같아야 서로의 상태를 알아보므로 키에 판 번호를 넣지 않는다.
- tsserver 플러그인의 로그 머리 `[…]`.
- 시험 고정물(`paths`, `plugins` 이름, 기대 문구).

### 6.3 생성기에 더하는 검사 하나

`createStore` 의 첫 인자가 문자열 그대로가 아니면 생성기가 실패한다. 문구는 `<파일>: createStore 의 key 는 문자열 그대로 쓴다`.
지금은 `collect` 가 그런 호출을 조용히 건너뛰어 그 store 가 `StateTypes` 에서 빠지고, 그 사실을 알려 주는 것은 fortuna 의 lint
(`state-key-literal`)뿐이다. eslint 를 켜지 않은 프로젝트에서도 잡히도록 생성기로 옮긴다. 둘째 인자가 함수 리터럴이 아닌 경우는
지금처럼 건너뛴다(정의를 다른 데서 지어 넘기는 꼴을 막을 근거가 아직 없다).

### 6.4 배포 묶음

- `package.json`: `private` 를 지우고 `version: "0.1.0"`, `license`, `repository`, `files: ["dist", "tools/*.cjs", "tools/*.mjs", "tools/*.d.mts"]`
  (시험 파일 `tools/*.test.mjs` 는 뺀다), `prepublishOnly: "pnpm build && pnpm test"`.
- `peerDependencies`: `typescript >=5.4`(필수), `react >=18`(선택). `vite`·`next` 는 선택 peer 로 적는다. 런타임 의존은 0개다.
- `tsconfig.json` 은 fortuna 의 `tsconfig.base.json` 을 상속하지 않고 필요한 옵션을 직접 적는다.
- 지금 fortuna 의 turbo 가 해 주던 `build` 가 시험 앞에 오도록 `test` 스크립트가 먼저 빌드한다(가방 시험이 `dist` 를 쓴다).

## 7. 설치한 프로젝트가 곧바로 쓰는 법 — 시작 절차

README 의 시작 절차는 이것이 전부다. 시험(§8 시험)이 이 절차를 그대로 밟는다.

```sh
npm i supa-store
```

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

**`targets` 의 기본값을 「모두 켜짐」(`["tsserver", "next", "vite", "cli"]`)으로 바꾼다** — Claude 가 정했다. 지금 기본값
`["tsserver"]` 이면 config 없이 `supaStore()`·`withStore`·`store-gen` 이 모두 아무 일도 하지 않아, 설치한 프로젝트가 config 파일을
하나 더 써야 한다. 생성 자리를 부른 것 자체가 켜겠다는 뜻이므로 기본은 켜 두고, `targets` 를 적으면 그것만 켜진다. fortuna 는
`targets` 를 적어 두었으므로 동작이 바뀌지 않는다. `StoreTarget` 에 `"vite"` 를 더한다.

**생성기는 tsconfig 의 `references` 를 따라간다** — Claude 가 정했다. `npm create vite` 의 react-ts 템플릿은 뿌리 `tsconfig.json`
을 `files: []` 와 `references` 만 둔 꼴로 두고 실제 설정을 `tsconfig.app.json` 에 둔다. 지금 `generate` 는 뿌리 tsconfig 하나만 읽어
그 템플릿에서는 정의 파일을 하나도 찾지 못하고 빈 생성 파일을 쓴다. 「설치한 프로젝트가 곧바로 쓴다」는 요구가 가장 흔한 시작점을
받아야 하므로, 뿌리 tsconfig 에 정의 파일이 없고 `references` 가 있으면 참조된 설정을 차례로 읽어 정의 파일(`config.match`)이
들어 있는 첫 설정으로 프로그램을 짓는다. 하나도 없으면 지금처럼 빈 생성 파일을 쓴다. tsserver 플러그인은 tsserver 가 이미
알맞은 프로젝트(`tsconfig.app.json`)에서 부르므로 고치지 않는다. 단일 tsconfig 인 fortuna·editor 는 동작이 바뀌지 않는다.

**README 의 「생성 파일」 절** — 사용자와 정했다(2026-10-24). 시작 절차는 위 두 줄로 끝내고, 생성 파일의 사정은 이 절이 적는다.

- 생성 파일은 TypeScript 타입이라 `tsc` 가 읽는다. 템플릿의 `build` 는 `tsc -b && vite build` 로 `tsc` 가 Vite 보다 먼저 돌므로,
  `tsc` 가 돌 때 생성 파일이 디스크에 있어야 한다. Tailwind 처럼 Vite 안에서만 짓는 꼴로는 안 되는 까닭이 이것이다
  (Tailwind 의 결과는 CSS 라 `tsc` 가 보지 않는다).
- **생성 파일은 커밋한다.** 편집기 플러그인(tsserver)과 Vite 개발 서버가 정의를 고칠 때마다 다시 쓰므로 저장소의 파일은 거의 늘
  최신이다. TanStack Router 의 `routeTree.gen.ts` 와 같은 꼴이다.
- 커밋된 파일이 낡는 경우는 하나다 — 편집기 플러그인 없이 정의를 쓰고 개발 서버도 띄우지 않은 채 곧바로 빌드할 때. 그런 흐름과,
  생성 파일을 커밋하지 않는 프로젝트(fortuna 처럼)는 `"build": "store-gen && tsc -b && vite build"` 처럼 빌드 앞에 `store-gen` 을 둔다.

선택 단계(README 의 「편집기에서 타입 따라오게 하기」 절):

- tsconfig `compilerOptions.plugins` 에 `{ "name": "supa-store/plugin" }` 를 더하고, VS Code 에서 작업 공간 TypeScript 를 쓴다.
- **모노레포라면 루트 `package.json` 의 devDependencies 에도 `supa-store` 를 둔다.** tsserver 는 플러그인을 tsconfig 폴더가 아니라
  TypeScript 가 놓인 자리에서 찾으므로 루트 `node_modules` 에 있어야 한다.
- 이 단계 없이도 빌드·시험·개발 서버는 동작한다. 편집기의 타입만 생성 파일이 다시 써질 때 따라온다.

## 8. Vite 플러그인 — `supa-store/vite`

`tools/vite.mjs`(ESM). `codegen.cjs` 의 `loadConfig`·`generate`·`requireTypeScript` 를 그대로 쓴다.

```js
export function supaStore() {
  let ts, config;
  return {
    name: "supa-store",
    configResolved(resolved) { ts = requireTypeScript(resolved.root); config = loadConfig(ts, resolved.root); },
    buildStart() { if (on()) generate(ts, config); },          // 실패하면 던진다 — 빌드를 멈춘다
    configureServer(server) {
      if (!on()) return;
      const again = debounce(() => { try { generate(ts, config); } catch (e) { server.config.logger.error(e.message); } }, 200);
      for (const event of ["add", "unlink", "change"])
        server.watcher.on(event, (file) => config.match(file) && again());
    },
  };
}
```

- `buildStart` 는 `vite build` 와 개발 서버 시작에서 모두 돈다. 빌드에서 생성이 실패하면 빌드가 실패한다. 개발 서버에서 감시로
  다시 짓다가 실패하면 로그만 남기고 서버는 살린다(`withStore` 와 같다).
- 프로젝트 뿌리는 Vite 의 `root` 에서 `package.json` 을 거슬러 찾는다(`loadConfig` 가 하는 일). Vite `root` 가 `src/` 같은 하위
  폴더여도 된다.
- 생성 파일이 다시 써지면 Vite 가 그 파일의 변경을 보고 HMR 로 전한다. 생성 파일은 정의를 다시 받는 진입점 쪽으로 갱신을
  올려 보내므로 보통 페이지가 다시 실린다. 이 동작을 바꾸지 않는다.
- `change` 를 보는 까닭: 정의를 고치면 반환 타입이 바뀌어 `StateTypes` 가 달라진다. 생성 파일의 런타임 부분(import 목록)은
  `add`·`unlink` 에서만 바뀌지만 타입 부분을 따라가게 하려고 함께 본다. `writeIfChanged` 가 같은 내용이면 쓰지 않으므로 HMR 이
  헛돌지 않는다.

**확인할 위험 하나.** `index.ts` 는 `process.env.NODE_ENV` 를 맨 이름으로 읽는다. Vite 는 의존을 미리 묶을(pre-bundle) 때 이것을
글자로 바꾸지만, 쓰는 쪽이 `optimizeDeps.exclude` 에 넣거나 링크로 설치하면 브라우저에서 `process is not defined` 가 날 수 있다.
가방 시험이 개발 서버 렌더도 보게 하고, 실패하면 `typeof process !== "undefined" && process.env.NODE_ENV === "production"` 으로 고친다.
고치더라도 「production 이면 같은 key 재등록을 막는다」는 동작은 그대로다.

## 9. 시험

- 지금의 시험을 모두 옮긴다: `src/*.test.ts(x)`(vitest), `tools/*.test.mjs`(`node --test`, 실제 tsserver 시험 포함).
- `tools/vite.test.mjs`(새로): Vite 의 `createServer` 를 임시 프로젝트에 띄우고, 정의 파일을 더하면 생성 파일에 그 key 가 생기고,
  지우면 없어지고, 반환 타입을 고치면 타입 글자가 바뀌는지 본다. `build()` 를 불러 생성이 먼저 도는지와 생성 실패가 빌드를
  실패시키는지 본다. `targets` 를 `["cli"]` 로 적은 config 에서는 아무것도 쓰지 않는지 본다.
- `tools/pack.test.mjs`(새로) — 목표 2 의 판정: `npm pack` 으로 묶음을 만들고, 임시 폴더에 `npm create vite` 의 react-ts 템플릿을
  그대로 깐 프로젝트에 설치한다. §7 의 두 줄과 정의 파일 하나·`useStore` 를 쓰는 컴포넌트 하나만 적는다. README 가 말하는
  순서대로 개발 서버를 먼저 띄워 생성 파일이 써지는 것과 첫 화면이 그 상태를 그리는지(브라우저 없이 `ssrLoadModule` 이나 jsdom 으로 충분하다 — 빌더가 고른다)와 `process` 위험(§8 Vite 플러그인)을 본다. 서버를 닫은 뒤 템플릿의 `npm run build`(`tsc -b && vite build`)를 그대로 돌린다.
  네트워크가 필요하므로(Vite·React 설치) 일반 `pnpm test` 와 떼어 `pnpm test:pack` 으로 두고, `prepublishOnly` 가 함께 부른다.
- 생성기 검사(§6.3 생성기에 더하는 검사 하나)의 시험을 `codegen.test.mjs` 에 더한다.

## 10. 배포하는 걸음

일은 세 걸음으로 끊는다.

1. Claude 가 새 저장소에서 §9 시험 의 가방 시험까지 통과시키고 커밋한다. 원격 저장소 `https://github.com/RoJaebl/supa-store`(공개)를
   만들고 push 하는 것은 바깥에 드러나는 일이라 그 자리에서 사용자 확인을 받는다. `package.json` 의 `repository` 는 이 주소로 적는다.
2. 사용자가 `npm login` 으로 로그인하고(`npm whoami` 로 확인), supa-store 폴더에서 `npm publish` 를 직접 돌린다. 2단계 인증의
   일회용 코드를 그 자리에서 넣어야 하므로 Claude 가 대신 돌리지 않는다. `prepublishOnly` 가 빌드·시험·가방 시험을 먼저 돌려
   실패하면 배포하지 않는다. scope 없는 이름이라 `--access` 는 필요 없다.
3. 배포가 확인되면(`npm view supa-store version` 이 `0.1.0`) §11 fortuna 를 옮기는 걸음 으로 간다.

## 11. fortuna 를 옮기는 걸음

배포가 끝난 다음에 한다. fortuna 의 git 전략대로 작업 브랜치에서 한다.

1. `apps/web/package.json` 과 루트 `package.json` 의 `"@fortuna-lottery/store": "workspace:*"` 를 `"supa-store": "^0.1.0"` 으로 바꾼다.
2. import 출처를 바꾼다: 화면 앱 소스·시험, `next.config.ts`, `store.config.ts`, tsconfig `plugins`(`supa-store/plugin`),
   **`apps/web/eslint.config.mjs` 의 `sources` 표와 `no-namespace-store-import` 무늬**, `tools/checks/eslint-*` 표본.
3. 생성 파일을 다시 쓴다(`store-gen`). `declare module "supa-store"` 로 바뀐다.
4. `packages/store` 를 지운다. `.dependency-cruiser.cjs`·`turbo.json`·`CLAUDE.md`(뼈대와 「이 저장소가 정한 것」)의 언급을 고친다.
5. 판정: `pnpm check` 통과, 그리고 `bash tools/checks/run-violations.sh`(위반 표본이 여전히 잡히는가)가 통과한다. 둘째가 §4 의
   「규칙이 조용히 꺼진다」를 잡는다.
6. 저장소 전체에서 `@fortuna-lottery/store` 를 찾아 0 건(설계·보고 문서처럼 그때의 사실을 적은 문서는 뺀다).

## 12. Claude 가 정한 것 — 사용자가 확인할 것

- 저장소를 이력째 떼어 낸다(§5 고려한 길).
- `targets` 의 기본값을 모두 켜짐으로 바꾼다(§7 시작 절차).
- 생성기가 tsconfig 의 `references` 를 따라간다(§7 시작 절차).
- 「곧바로 쓴다」의 기준을 설치 뒤 두 줄(Vite 플러그인, 생성 파일 import)로 두고 가방 시험으로 판정한다(§7 시작 절차, §9 시험). 생성 파일의 사정은 README 의 「생성 파일」 절이 적는다 — 사용자와 정했다.
- 생성기가 문자열이 아닌 key 를 실패로 다룬다(§6.3 생성기에 더하는 검사 하나).
- `./tools/plugin.cjs` 하위 경로를 지우고 `/plugin` 하나로 둔다(§6.1 하위 경로).
- 라이선스는 MIT 로 둔다.

## 13. 빌더에게 맡기는 것

- 가방 시험에서 렌더를 확인하는 수단(jsdom 또는 `ssrLoadModule`).
- 디바운스 시간과 Vite 판본 하한(editor 는 Vite 8 을 쓴다 — 그 판에서 반드시 돌아야 한다).
- README 의 나머지 구성.
