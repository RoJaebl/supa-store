import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { requireTypeScript } = require("./codegen.cjs");
const init = require("./plugin.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");
const storeIndex = posix(resolve(here, "../src/index.ts"));
const ts = requireTypeScript(resolve(here, "../../../apps/web"));
const COUNT = `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.count", (set, get) => ({ n: 0, add: () => set({ n: get().n + 1 }) }));`;

let root;
let versions; // 시험이 고친 파일의 판본표 — 나머지는 디스크에서 읽는다
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const edit = (rel, text) => {
  write(rel, text);
  const file = posix(join(root, rel));
  versions.set(file, (versions.get(file) ?? 0) + 1);
};

beforeEach(() => {
  root = posix(mkdtempSync(join(tmpdir(), "store-plugin-")));
  versions = new Map();
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

function createHost() {
  const { config } = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const { fileNames, options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
  return {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (f) => String(versions.get(posix(f)) ?? 0),
    getScriptSnapshot: (f) => (ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)) : undefined),
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
}

function createWithInfo(dir, logs = []) {
  const host = createHost();
  const info = {
    languageServiceHost: host,
    languageService: ts.createLanguageService(host),
    project: {
      getCurrentDirectory: () => dir,
      projectService: { logger: { info: (m) => logs.push(m) } },
    },
  };
  const returned = init({ typescript: ts }).create(info);
  return { info, returned, host };
}
const createPluggedService = (dir) => createWithInfo(dir).returned;
const diagnostics = (ls, rel) =>
  ls.getSemanticDiagnostics(posix(join(root, rel))).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
const settle = (ls) => {
  diagnostics(ls, "src/use.ts");
  diagnostics(ls, "src/use.ts");
};

test("정의를 고치면 다음 진단에서 새 필드를 알고 생성 파일을 디스크에도 쓴다", () => {
  write("store.config.ts", `export default { targets: ["tsserver"] };`);
  write("src/a/_state/count.state.ts", COUNT);
  write(
    "src/use.ts",
    `import "./store.gen";
import { getStore } from "@fortuna-lottery/store";
export const label = getStore("state.a.count").getState().label;`,
  );
  const ls = createPluggedService(root);
  assert.ok(diagnostics(ls, "src/use.ts").some((d) => /label/.test(d)));
  edit("src/a/_state/count.state.ts", COUNT.replace("n: 0", 'n: 0, label: "x"'));
  settle(ls); // 판본이 따라잡도록 진단을 두 번 돈다 — 플러그인은 직전 프로그램으로 짓는다
  assert.deepEqual(diagnostics(ls, "src/use.ts"), []);
  assert.match(readFileSync(join(root, "src/store.gen.ts"), "utf8"), /label: string/);
});

test("정의 파일의 문법이 깨지면 앞의 내용을 그대로 대 주고 디스크에도 쓰지 않는다", () => {
  write("src/a/_state/count.state.ts", COUNT);
  write("src/use.ts", `import "./store.gen";`);
  const logs = [];
  const { returned: ls, host } = createWithInfo(root, logs);
  settle(ls);
  const gen = join(root, "src/store.gen.ts");
  const before = readFileSync(gen, "utf8");
  assert.match(before, /n: number/);
  edit("src/a/_state/count.state.ts", COUNT.replace("n: 0", "n: ,"));
  settle(ls);
  const snapshot = host.getScriptSnapshot(posix(gen));
  assert.equal(snapshot.getText(0, snapshot.getLength()), before);
  assert.equal(readFileSync(gen, "utf8"), before);
  assert.doesNotMatch(before, /any/);
  assert.ok(logs.some((l) => /count\.state\.ts/.test(l)));
});

test("tsserver 가 꺼져 있으면 언어 서비스를 그대로 돌려준다", () => {
  write("store.config.ts", `export default { targets: ["cli"] };`);
  const { info, returned } = createWithInfo(root);
  assert.equal(returned, info.languageService);
});

test("config 가 깨져도 언어 서비스를 그대로 돌려주고 로그를 남긴다", () => {
  write("store.config.ts", "export default {");
  const logs = [];
  const { info, returned } = createWithInfo(root, logs);
  assert.equal(returned, info.languageService);
  assert.ok(logs.some((l) => /store\.config\.ts/.test(l)));
});

test("역슬래시로 물어도 생성 파일로 알아본다", () => {
  write("src/a/_state/count.state.ts", COUNT);
  const { host } = createWithInfo(root);
  const snapshot = host.getScriptSnapshot(`${root}\\src\\store.gen.ts`.replaceAll("/", "\\"));
  assert.match(snapshot.getText(0, snapshot.getLength()), /"state\.a\.count"/);
});
