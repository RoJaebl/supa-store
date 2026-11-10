// 가방 시험 — npm pack 으로 만든 묶음을 vite 의 react-ts 템플릿에 설치해 README 의 시작 절차(번들러 장치 하나, 생성 단계 없음)를 그대로 밟는다.
// 네트워크가 필요하다(create-vite, npm install). pnpm test 와 떼어 pnpm test:pack 으로 돌린다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP = 10 * 60_000;
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe", timeout: STEP, encoding: "utf8" });

test("묶음을 템플릿에 설치해 번들러 장치만 걸고 개발 서버와 빌드(tsc -b && vite build)가 돈다", { timeout: 4 * STEP }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "supa-store-pack-"));
  let server;
  try {
    // 1. 묶음
    const tgz = join(tmp, run(`npm pack --pack-destination "${tmp}" --silent`, repo).trim().split(/\r?\n/).pop());
    assert.ok(existsSync(tgz));

    // 2. 템플릿 + 설치
    run("npm create vite@latest app -- --template react-ts --no-interactive", tmp);
    const app = join(tmp, "app");
    run("npm install", app);
    run(`npm install "${tgz}"`, app);
    // 0.6 의 생성기 명령은 묶음에 없다
    assert.ok(!existsSync(join(app, "node_modules/.bin/store-gen")));
    // 0.3 · 0.4 의 하위 경로가 exports 로 풀린다
    run(`node --input-type=module -e "for (const p of [\\"stream\\", \\"server\\", \\"server/node\\", \\"server/web\\", \\"rpc\\"]) await import(\\"@rojaebl/supa-store/\\" + p)"`, app);

    // 3. 시작 절차 — 번들러 장치 하나
    const file = (rel) => join(app, rel);
    const cfg = readFileSync(file("vite.config.ts"), "utf8");
    assert.match(cfg, /plugins: \[react\(\)\]/);
    writeFileSync(
      file("vite.config.ts"),
      `import { supaStore } from "@rojaebl/supa-store/vite";\n${cfg.replace("plugins: [react()]", "plugins: [react(), supaStore()]")}`,
    );

    // 4. 정의 하나와 그것을 핸들로 꺼내는 컴포넌트 — creator 가 인자를 받으므로 타입 인자를 적는다
    writeFileSync(
      file("src/count.ts"),
      `import { createStore } from "@rojaebl/supa-store";\nexport const count = createStore<{ n: number; inc: () => void }>((set) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));\n`,
    );
    writeFileSync(
      file("src/App.tsx"),
      `import { useStore } from "@rojaebl/supa-store/react";\nimport { count } from "./count";\nimport { title } from "./todo";\nexport default function App() {\n  const { n } = useStore(count, { pick: ["n"] });\n  const { read } = useStore(title, { pick: ["read"] });\n  const t: string | undefined = read();\n  return <p id="n" title={t}>n={n}</p>;\n}\n`,
    );
    // 자원과 event 도 핸들로 — 그 타입이 node_modules 의 supa-store 를 가리키고, 짓는 동안 on 을 건다
    writeFileSync(
      file("src/todo.ts"),
      `import { createStore, type Store } from "@rojaebl/supa-store";\nimport { createEvent, createResource } from "@rojaebl/supa-store/query";\nexport const todo = createStore(() => createResource(() => ({ query: async () => ({ title: "t" }) })));\nexport const saved = createStore(() => createEvent<number>());\nexport const log: Store<{ last: number }> = createStore((set, _get, ctx) => {\n  ctx(saved).on((n) => set({ last: n }));\n  return { last: 0 };\n});\n// ctx 만 쓰는 정의 — 타입 인자 없이 추론된다\nexport const title = createStore.ofContext((ctx) => ({ read: () => ctx(todo).getData()?.title }));\n`,
    );

    // 5. 개발 서버 — 첫 화면이 상태를 그린다
    const { createServer } = await import(pathToFileURL(file("node_modules/vite/dist/node/index.js")).href);
    server = await createServer({ root: app, logLevel: "silent", server: { port: 0 } });
    await server.listen();
    const { default: App } = await server.ssrLoadModule("/src/App.tsx");
    const appRequire = createRequire(file("package.json")); // 앱의 react 를 앱이 쓰는 그대로 쓴다
    const { createElement } = appRequire("react");
    const { renderToString } = appRequire("react-dom/server");
    assert.match(renderToString(createElement(App)), /n=(<!-- -->)?1/);

    // 브라우저 쪽 묶음에 process 가 날것으로 남아 "process is not defined" 가 나지 않는지
    const base = server.resolvedUrls.local[0];
    await fetch(`${base}src/main.tsx`);
    const dep = await (await fetch(`${base}node_modules/.vite/deps/@rojaebl_supa-store.js`)).text();
    assert.match(dep, /createStore/); // 빈 응답이나 404 로 헛통과하지 않게
    assert.doesNotMatch(dep.replace(/typeof process\s*!==\s*"undefined"\s*&&\s*/g, ""), /\bprocess\b/);

    // 6. 서버를 닫고 템플릿의 빌드(tsc -b && vite build)를 그대로 돌린다
    await server.close();
    server = undefined;
    run("npm run build", app);
    assert.ok(existsSync(file("dist/index.html")));
  } finally {
    await server?.close();
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {} // Windows 에서 방금 닫은 서버의 잠금이 남을 수 있다 — 임시 폴더라 남겨도 된다
  }
});
