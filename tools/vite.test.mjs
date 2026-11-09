import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, build } from "vite";
import { supaStore } from "./vite.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const storeIndex = resolve(here, "../src/index.ts").split("\\").join("/");

// 컴포넌트가 스스로 갱신을 받아 Fast Refresh 경계가 된다 — 장치가 없으면 정의 파일을 고친 갱신도 여기서 받아진다
const FILES = {
  "src/util.ts": `export const one = 1;`,
  "src/a.state.ts": `import { createStore } from "supa-store";\nimport { one } from "./util";\nexport const a = createStore(() => ({ n: one }));`,
  "src/view.ts": `import { a } from "./a.state";\nimport { one } from "./util";\nexport const v = [a, one];\nimport.meta.hot.accept();`,
  "src/other.ts": `export const o = 1;\nimport.meta.hot.accept();`,
  "src/main.ts": `import "./view";\nimport "./other";`,
};

let root;
let servers;
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 서버를 띄우고 client 환경이 보내는 것을 모은다. 모든 모듈을 읽혀 모듈 그래프를 세운다
async function start() {
  const server = await createServer({
    root,
    configFile: false,
    plugins: [supaStore()],
    resolve: { alias: { "supa-store": storeIndex } },
    server: { middlewareMode: true, ws: false },
    logLevel: "silent",
  });
  servers.push(server);
  const sent = [];
  const hot = server.environments.client.hot;
  const send = hot.send.bind(hot);
  hot.send = (payload, ...rest) => {
    sent.push(typeof payload === "string" ? { type: "custom", event: payload } : payload);
    return send(payload, ...rest);
  };
  for (const rel of Object.keys(FILES)) await server.transformRequest(`/${rel}`);
  await wait(500); // 감시자가 폴더를 훑기 전의 변경은 놓치므로 기다린다
  return sent;
}

// 파일을 고치고 무엇이든 보낼 때까지(최대 5초) 기다린다
async function edit(sent, rel, text) {
  write(rel, text);
  for (let i = 0; i < 100 && !sent.length; i++) await wait(50);
  assert.ok(sent.length, `${rel} 을 고쳤는데 아무것도 보내지 않았다`);
  return sent.map((p) => p.type);
}

beforeEach(() => {
  servers = [];
  root = mkdtempSync(join(tmpdir(), "store-vite-"));
  write("package.json", "{}");
  for (const [rel, text] of Object.entries(FILES)) write(rel, text);
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("정의 파일을 고치면 full-reload 를 보낸다", async () => {
  const sent = await start();
  const types = await edit(sent, "src/a.state.ts", FILES["src/a.state.ts"] + "\n// 고쳤다");
  assert.deepEqual(types, ["full-reload"]);
});

test("정의 파일이 import 하는 util 을 고치면 full-reload 를 보낸다", async () => {
  const sent = await start();
  const types = await edit(sent, "src/util.ts", `export const one = 2;`);
  assert.deepEqual(types, ["full-reload"]);
});

test("정의와 무관한 컴포넌트를 고치면 full-reload 를 보내지 않는다", async () => {
  const sent = await start();
  const types = await edit(sent, "src/other.ts", `export const o = 2;\nimport.meta.hot.accept();`);
  assert.deepEqual(types, ["update"]);
});

test("빌드에서는 아무것도 하지 않는다", async () => {
  await build({
    root,
    configFile: false,
    plugins: [supaStore()],
    resolve: { alias: { "supa-store": storeIndex } },
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: join(root, "src/main.ts") } },
  });
  assert.equal(existsSync(join(root, "src/store.gen.ts")), false);
});

test("vitest 안에서는 아무것도 하지 않는다", async () => {
  const before = process.env.VITEST;
  process.env.VITEST = "true";
  let sent;
  try {
    sent = await start();
  } finally {
    if (before === undefined) delete process.env.VITEST;
    else process.env.VITEST = before;
  }
  const types = await edit(sent, "src/a.state.ts", FILES["src/a.state.ts"] + "\n// 고쳤다");
  assert.deepEqual(types, ["update"]);
});
