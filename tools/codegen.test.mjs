import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadConfig, generate, requireTypeScript } = require("./codegen.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");
const storeIndex = posix(resolve(here, "../src/index.ts"));
const ts = requireTypeScript(resolve(here, "../../../apps/web"));

let root;
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (rel) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "store-codegen-"));
  write("package.json", "{}");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        skipLibCheck: true,
        paths: { "@fortuna-lottery/store": [storeIndex] },
      },
      include: ["src"],
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("config 파일이 없으면 기본값을 쓴다", () => {
  const config = loadConfig(ts, root);
  assert.equal(config.out, `${posix(root)}/src/store.gen.ts`);
  assert.equal(config.enabled("tsserver"), true);
  assert.equal(config.enabled("cli"), false);
  assert.equal(config.match(`${root}\\src\\a\\b.state.ts`), true); // 역슬래시 경로도 맞힌다
  assert.equal(config.match(`${root}/src/a/b.ts`), false);
});

test("store.config.ts 가 기본값 위에 얹히고 @fortuna-lottery/store/config 를 풀어 낸다", () => {
  write(
    "store.config.ts",
    `import { defineConfig } from "@fortuna-lottery/store/config";
export default defineConfig({ out: "src/gen/x.gen.ts", targets: ["cli"] });`,
  );
  const config = loadConfig(ts, root);
  assert.equal(config.out, `${posix(root)}/src/gen/x.gen.ts`);
  assert.equal(config.enabled("cli"), true);
  assert.equal(config.enabled("tsserver"), false);
});

test("문법이 깨진 config 는 파일 이름을 담아 실패한다", () => {
  write("store.config.ts", "export default {");
  assert.throws(() => loadConfig(ts, root), /store\.config\.ts/);
});

test("괄호·대괄호가 든 경로의 정의를 찾아 타입을 글자로 쓴다", () => {
  write(
    "src/app/(home)/_state/combination.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
createStore("state.home.combination", (set) => ({
  numbers: null as number[] | null,
  choose: (numbers: number[]) => set({ numbers }),
}));`,
  );
  write(
    "src/app/documents/[id]/_state/panel.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
createStore("state.documents.[id].panel", (set, get) => ({ open: false, toggle: () => set({ open: !get().open }) }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /^\/\/ 자동 생성 — @fortuna-lottery\/store 가 쓴다\. 고치지 않는다/);
  assert.match(out, /import "\.\/app\/\(home\)\/_state\/combination\.state";/);
  assert.match(out, /import "\.\/app\/documents\/\[id\]\/_state\/panel\.state";/);
  assert.match(out, /"state\.home\.combination": \{ numbers: number\[\] \| null; choose: \(numbers: number\[\]\) => void; \};/);
  assert.match(out, /"state\.documents\.\[id\]\.panel": \{ open: boolean; toggle: \(\) => void; \};/);
  assert.ok(out.indexOf('"state.documents') < out.indexOf('"state.home')); // key 순
});

test("export 한 이름 붙은 타입은 생성 파일 기준 상대 import 로 쓴다", () => {
  write("src/types.ts", "export type Pick = { id: string };");
  write(
    "src/a/_state/last.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
import type { Pick } from "../../types";
createStore("state.a.last", () => ({ last: null as Pick | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /last: import\("\.\/types"\)\.Pick \| null/);
});

test("리터럴이 아닌 key·함수가 아닌 정의는 건너뛴다", () => {
  write(
    "src/a/_state/odd.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
const KEY = "state.a.odd";
createStore(KEY, () => ({ n: 0 }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.doesNotMatch(read("src/store.gen.ts"), /state\.a\.odd/);
});

test("정의가 없으면 빈 StateTypes 를 쓴다", () => {
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /interface StateTypes \{\n {2}\}/);
});

test("내용이 같으면 다시 쓰지 않는다", () => {
  const config = loadConfig(ts, root);
  assert.equal(generate(ts, config), true);
  assert.equal(generate(ts, config), false);
});

test("Windows 에서는 드라이브 글자의 대소문자가 달라도 맞힌다", { skip: process.platform !== "win32" }, () => {
  const config = loadConfig(ts, root);
  const first = posix(root)[0];
  const flipped = (first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase()) + posix(root).slice(1);
  assert.equal(config.match(`${flipped}/src/a/b.state.ts`), true);
});

test("문법이 깨진 정의 파일은 파일 이름을 담아 실패하고 any 를 쓰지 않는다", () => {
  const config = loadConfig(ts, root);
  write("src/store.gen.ts", "// 앞선 생성본");
  write(
    "src/a/_state/broken.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.broken", () => ({ n: , }));`,
  );
  assert.throws(() => generate(ts, config), /broken\.state\.ts/);
  assert.equal(read("src/store.gen.ts"), "// 앞선 생성본");
});

test("깨진 tsconfig 는 tsconfig.json 을 담아 실패하고 생성 파일을 건드리지 않는다", () => {
  const config = loadConfig(ts, root);
  write("src/store.gen.ts", "// 앞선 생성본");
  write("tsconfig.json", JSON.stringify({ extends: "./missing.json", include: ["src"] }));
  assert.throws(() => generate(ts, config), /tsconfig\.json/);
  assert.equal(read("src/store.gen.ts"), "// 앞선 생성본");
});

test("새 key 의 첫 생성에서도 get() 에 기대는 함수의 반환 타입이 맞게 찍힌다", () => {
  write(
    "src/x/_state/y.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
createStore("state.x.y", (set, get) => ({ n: 1, read: () => get().n }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /"state\.x\.y": \{ n: number; read: \(\) => number; \};/);
});

test("결과에 any 가 남으면 key 와 파일을 담아 실패하고 생성 파일을 쓰지 않는다", () => {
  const config = loadConfig(ts, root);
  write("src/store.gen.ts", "// 앞선 생성본");
  write(
    "src/a/_state/loop.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.loop", () => ({ f(n: number) { return n ? this.f(n - 1) : 0; } }));`,
  );
  assert.throws(
    () => generate(ts, config),
    (e) => /\bany\b/.test(e.message) && /state\.a\.loop/.test(e.message) && /loop\.state\.ts/.test(e.message),
  );
  assert.equal(read("src/store.gen.ts"), "// 앞선 생성본");
});

test("문자열·이름 속의 any 는 거부하지 않는다", () => {
  write(
    "src/a/_state/word.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.word", () => ({ company: "any" as const, anyway: 1 }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /company: "any"; anyway: number;/);
});

test("createResource 를 돌려주는 정의도 any 없이 찍힌다", () => {
  const tsconfig = JSON.parse(read("tsconfig.json"));
  tsconfig.compilerOptions.paths["@fortuna-lottery/store/query"] = [posix(resolve(here, "../src/query.ts"))];
  write("tsconfig.json", JSON.stringify(tsconfig));
  write(
    "src/x/_state/r.state.ts",
    `import { createStore } from "@fortuna-lottery/store";
import { createResource } from "@fortuna-lottery/store/query";
createStore("api.x.r", () => createResource(() => ({ query: async () => 1 })));`,
  );
  generate(ts, loadConfig(ts, root));
  const line = read("src/store.gen.ts").split("\n").find((l) => l.includes('"api.x.r"'));
  assert.ok(line, "api.x.r 가 찍힌다");
  assert.doesNotMatch(line, /\bany\b/);
});
