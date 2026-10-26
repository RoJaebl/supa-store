// 가방 시험 — npm pack 으로 만든 묶음을 vite 의 react-ts 템플릿에 설치해 README 의 시작 절차를 그대로 밟는다.
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
const wait = async (ok, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return;
  assert.fail("기다리던 일이 일어나지 않았다");
};

test("묶음을 템플릿에 설치해 시작 절차 두 줄로 개발 서버와 빌드가 돈다", { timeout: 4 * STEP }, async () => {
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
    // tsserver 가 node10 방식으로 찾는 중계 폴더가 설치본에 있다(exports 를 거치지 않는다)
    assert.ok(existsSync(join(app, "node_modules/supa-store/plugin/index.js")));
    // 0.3 의 하위 경로가 exports 로 풀린다
    run(`node --input-type=module -e "for (const p of [\\"stream\\", \\"server\\", \\"server/node\\", \\"server/web\\"]) await import(\\"supa-store/\\" + p)"`, app);

    // 3. 시작 절차 두 줄
    const file = (rel) => join(app, rel);
    const cfg = readFileSync(file("vite.config.ts"), "utf8");
    assert.match(cfg, /plugins: \[react\(\)\]/);
    writeFileSync(
      file("vite.config.ts"),
      `import { supaStore } from "supa-store/vite";\n${cfg.replace("plugins: [react()]", "plugins: [react(), supaStore()]")}`,
    );
    writeFileSync(file("src/main.tsx"), `import "./store.gen";\n${readFileSync(file("src/main.tsx"), "utf8")}`);

    // 4. 정의 하나와 그것을 꺼내는 컴포넌트
    writeFileSync(
      file("src/count.state.ts"),
      `import { createStore } from "supa-store";\ncreateStore("count", (set) => ({ n: 1, inc: () => set((s) => ({ n: s.n + 1 })) }));\n`,
    );
    writeFileSync(
      file("src/App.tsx"),
      `import { useStore } from "supa-store/react";\nexport default function App() {\n  const { n } = useStore("count", { pick: ["n"] });\n  return <p id="n">n={n}</p>;\n}\n`,
    );

    // 5. 개발 서버 — 생성 파일이 써지고 첫 화면이 상태를 그린다
    const { createServer } = await import(pathToFileURL(file("node_modules/vite/dist/node/index.js")).href);
    server = await createServer({ root: app, logLevel: "silent", server: { port: 0 } });
    await server.listen();
    await wait(() => existsSync(file("src/store.gen.ts")) && readFileSync(file("src/store.gen.ts"), "utf8").includes("count"));
    await server.ssrLoadModule("/src/store.gen.ts");
    const { default: App } = await server.ssrLoadModule("/src/App.tsx");
    const appRequire = createRequire(file("package.json")); // 앱의 react 를 앱이 쓰는 그대로 쓴다
    const { createElement } = appRequire("react");
    const { renderToString } = appRequire("react-dom/server");
    assert.match(renderToString(createElement(App)), /n=(<!-- -->)?1/);

    // 브라우저 쪽 묶음에 process 가 날것으로 남아 "process is not defined" 가 나지 않는지
    const base = server.resolvedUrls.local[0];
    await fetch(`${base}src/main.tsx`);
    const dep = await (await fetch(`${base}node_modules/.vite/deps/supa-store.js`)).text();
    assert.match(dep, /createStore/); // 빈 응답이나 404 로 헛통과하지 않게
    assert.doesNotMatch(dep.replace(/typeof process\s*!==\s*"undefined"\s*&&\s*/g, ""), /\bprocess\b/);

    // 6. 서버를 닫고 템플릿의 빌드를 그대로 돌린다
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
