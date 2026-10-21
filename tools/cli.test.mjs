import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");
const storeIndex = posix(resolve(here, "../src/index.ts"));
const cli = join(here, "cli.mjs");
const tscBin = resolve(here, "../../../apps/web/node_modules/typescript/bin/tsc");
const COUNT = `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.count", (set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));`;

let root;
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (rel) => readFileSync(join(root, rel), "utf8");
const run = () => spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
const tsc = (dir) =>
  spawnSync(process.execPath, [tscBin, "-p", join(dir, "tsconfig.json"), "--noEmit"], { encoding: "utf8" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "store-cli-"));
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

test("cli 가 꺼져 있으면 건너뛴다는 한 줄을 남기고 0 으로 끝난다", () => {
  const r = run(); // config 없음 — 기본 targets 는 tsserver 뿐이다
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /store-gen: targets 에 cli 가 없어 건너뛴다/);
  assert.equal(existsSync(join(root, "src/store.gen.ts")), false);
});

test("cli 가 켜져 있으면 생성 파일을 쓴다", () => {
  write("store.config.ts", `export default { targets: ["cli"] };`);
  write("src/a/_state/count.state.ts", COUNT);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(read("src/store.gen.ts"), /"state\.a\.count"/);
});

test("config 가 깨지면 파일 이름을 담아 0 이 아닌 값으로 끝난다", () => {
  write("store.config.ts", "export default {");
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /store\.config\.ts/);
});

test("생성 뒤 tsc 가 없는 key·없는 필드·set 의 없는 필드를 잡는다", () => {
  write("store.config.ts", `export default { targets: ["cli"] };`);
  write("src/a/_state/count.state.ts", COUNT);
  write(
    "src/use.ts",
    `import "./store.gen";
import { getStore, createStore } from "@fortuna-lottery/store";
// @ts-expect-error 없는 key
getStore("state.a.none");
// @ts-expect-error 없는 필드
getStore("state.a.count").getState().nope;
// @ts-expect-error set 의 없는 필드
createStore("state.a.count", (set) => ({ n: 0, add: () => set({ nope: 1 }) }));
const n: number = getStore("state.a.count").getState().n;
export { n };`,
  );
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const t = tsc(root);
  assert.equal(t.status, 0, t.stdout); // @ts-expect-error 가 하나라도 남으면 실패한다
});

test("생성 파일이 없으면 모든 key 가 never 다", () => {
  write(
    "src/use.ts",
    `import { getStore } from "@fortuna-lottery/store";
// @ts-expect-error StateTypes 가 비면 key 가 never 다
getStore("state.a.count");`,
  );
  const t = tsc(root);
  assert.equal(t.status, 0, t.stdout);
});
