import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withStore } from "./next.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");
const storeIndex = posix(resolve(here, "../src/index.ts"));
const COUNT = `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.count", (set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));`;

let root;
const roots = [];
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (rel) => readFileSync(join(root, rel), "utf8");
const inDir = (dir, fn) => {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
};
const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("기다린 조건이 끝내 맞지 않았다");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "store-next-"));
  roots.push(root);
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
// dev 시험의 감시자가 마지막 폴더를 쥐고 있으므로 지우기는 프로세스가 끝날 때 한다
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

test("next 가 켜져 있으면 설정을 읽을 때 생성하고 설정을 그대로 돌려준다", () => {
  write("store.config.ts", `export default { targets: ["next"] };`);
  write("src/a/_state/count.state.ts", COUNT);
  const config = { typedRoutes: true };
  assert.equal(inDir(root, () => withStore(config)("phase-production-build")), config);
  assert.match(read("src/store.gen.ts"), /"state\.a\.count"/);
});

test("next 가 꺼져 있으면 아무것도 쓰지 않는다", () => {
  write("src/a/_state/count.state.ts", COUNT);
  inDir(root, () => withStore({})("phase-production-build"));
  assert.equal(existsSync(join(root, "src/store.gen.ts")), false);
});

test("dev 에서 감시를 걸지 못하면 dev 서버를 죽이지 않고 표식도 남기지 않는다", () => {
  // src 폴더가 없어 fs.watch 가 ENOENT 로 던진다
  write("store.config.ts", `export default { targets: ["next"], out: "gen/store.gen.ts" };`);
  const config = {};
  assert.equal(inDir(root, () => withStore(config)("phase-development-server")), config);
  assert.equal(globalThis[Symbol.for("@fortuna-lottery/store/watching")], undefined);
});

// 감시는 globalThis 표식으로 한 번만 걸리므로 이 시험은 마지막에 둔다
test("dev 에서는 정의 파일의 내용이 바뀌면 다시 쓴다", async () => {
  write("store.config.ts", `export default { targets: ["next"] };`);
  write("src/a/_state/count.state.ts", COUNT);
  inDir(root, () => withStore({})("phase-development-server"));
  write("src/a/_state/count.state.ts", COUNT.replace("n: 0", 'n: 0, label: "x"'));
  await waitFor(() => /label: string/.test(read("src/store.gen.ts")), 3000);
});
