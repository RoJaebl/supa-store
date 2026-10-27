import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, build } from "vite";
import { supaStore } from "./vite.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const storeIndex = resolve(here, "../src/index.ts").split("\\").join("/");

const def = (key, body) => `import { createStore } from "supa-store";\ncreateStore("${key}", () => (${body}));`;
const BAD = `import { createStore } from "supa-store";\ncreateStore("a", () => ({ n: );`;

let root;
let servers;
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");
const GEN = "src/store.gen.ts";

// 조건이 맞을 때까지 50ms 간격으로 최대 5초 기다린다
async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check(read(GEN))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${message}\n${read(GEN)}`);
}

async function start(options = {}) {
  const errors = [];
  const server = await createServer({
    root,
    configFile: false,
    plugins: [supaStore()],
    server: { middlewareMode: true },
    logLevel: "silent",
    customLogger: { info() {}, warn() {}, warnOnce() {}, error: (m) => errors.push(m), clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
    ...options,
  });
  servers.push(server);
  await new Promise((r) => setTimeout(r, 500)); // 감시자가 폴더를 훑기 전의 변경은 놓치므로 기다린다
  return { server, errors };
}

beforeEach(() => {
  servers = [];
  root = mkdtempSync(join(tmpdir(), "store-vite-"));
  write("package.json", "{}");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", skipLibCheck: true, paths: { "supa-store": [storeIndex] } },
      include: ["src"],
    }),
  );
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("서버를 띄우면 생성 파일을 쓴다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start();
  assert.match(read(GEN), /"a":/);
});

test("정의를 더하면 다시 쓴다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start();
  write("src/b.state.ts", def("b", "{ n: 0 }"));
  await until((t) => t.includes('"b":'), "b 가 생기지 않았다");
});

test("정의를 지우면 다시 쓴다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  write("src/b.state.ts", def("b", "{ n: 0 }"));
  await start();
  rmSync(join(root, "src/a.state.ts"));
  await until((t) => !t.includes('"a":') && !t.includes("a.state") && t.includes('"b":'), "a 가 사라지지 않았다");
});

test("정의를 고치면 타입 글자가 바뀐다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start();
  write("src/a.state.ts", def("a", '{ s: "" }'));
  await until((t) => t.includes("s: string"), "s: string 이 생기지 않았다");
});

test("감시 중 생성은 개발 서버의 스레드를 막지 않는다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start();
  let last = Date.now();
  let max = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    max = Math.max(max, now - last);
    last = now;
  }, 10);
  try {
    write("src/b.state.ts", def("b", "{ n: 0 }"));
    await until((t) => t.includes('"b":'), "b 가 생기지 않았다");
  } finally {
    clearInterval(tick);
  }
  // 같은 스레드에서 돌면 TypeScript 프로그램을 짓는 동안(이 작은 프로젝트에서도 0.5초 넘게) 타이머가 멈춘다
  assert.ok(max < 200, `이벤트 루프가 ${max}ms 멈췄다`);
});

test("생성이 도는 동안 들어온 변경은 끝난 뒤 한 번 더 돌아 마지막 정의를 쓴다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start();
  write("src/a.state.ts", def("a", '{ s: "" }'));
  await new Promise((r) => setTimeout(r, 300)); // 디바운스가 지나 생성이 도는 중이다
  write("src/a.state.ts", def("a", "{ b: true }"));
  await until((t) => t.includes("b: boolean"), "마지막 정의가 생성 파일에 오지 않았다");
});

test("감시 중 생성이 실패해도 서버는 살아 있고 고치면 다시 쓴다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  const { errors } = await start();
  const before = read(GEN);
  write("src/a.state.ts", BAD);
  for (let i = 0; i < 100 && !errors.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(errors.join("\n"), /정의 파일의 문법이 깨져/);
  assert.equal(read(GEN), before);
  write("src/a.state.ts", def("a", '{ s: "" }'));
  await until((t) => t.includes("s: string"), "고친 뒤 다시 쓰지 않았다");
});

test("개발 서버 시작 때 생성이 실패해도 서버는 뜨고 고치면 다시 쓴다", async () => {
  write("src/a.state.ts", BAD);
  const { errors } = await start();
  assert.match(errors.join("\n"), /정의 파일의 문법이 깨져/);
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await until((t) => t.includes('"a":'), "고친 뒤 다시 쓰지 않았다");
});

test("감시자가 역슬래시 경로를 넘겨도 맞힌다", async (t) => {
  if (process.platform !== "win32") return t.skip();
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  const { server } = await start();
  write("src/b.state.ts", def("b", "{ n: 0 }"));
  const path = join(root, "src", "b.state.ts").replace(/\//g, "\\");
  server.watcher.emit("add", path[0].toUpperCase() + path.slice(1));
  await until((t) => t.includes('"b":'), "역슬래시 경로로 다시 쓰지 않았다");
});

test("Vite root 가 src 여도 뿌리를 찾는다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start({ root: join(root, "src") });
  assert.match(read(GEN), /"a":/);
});

test("build 가 먼저 생성하고 생성 실패는 빌드를 실패시킨다", async () => {
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  write("src/main.ts", `import "./a.state";\nexport const x = 1;`);
  const run = () =>
    build({ root, configFile: false, plugins: [supaStore()], logLevel: "silent", build: { write: false, rollupOptions: { input: join(root, "src/main.ts") } } });
  await run();
  assert.match(read(GEN), /"a":/);
  write("src/a.state.ts", BAD);
  await assert.rejects(run(), /정의 파일의 문법이 깨져/);
});

test('targets 에 vite 가 없으면 아무것도 쓰지 않는다', async () => {
  write("store.config.ts", `export default { targets: ["cli"] };`);
  write("src/a.state.ts", def("a", "{ n: 0 }"));
  await start();
  assert.equal(existsSync(join(root, GEN)), false);
});
