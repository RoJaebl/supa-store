import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadConfig, generate, render, requireTypeScript } = require("./codegen.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");
const storeIndex = posix(resolve(here, "../src/index.ts"));
const ts = requireTypeScript(resolve(here, ".."));

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
        paths: { "supa-store": [storeIndex], "supa-store/query": [posix(resolve(here, "../src/query.ts"))] },
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
  for (const t of ["next", "vite", "cli"]) assert.equal(config.enabled(t), true);
  assert.equal(config.match(`${root}\\src\\a\\b.state.ts`), true); // 역슬래시 경로도 맞힌다
  assert.equal(config.match(`${root}/src/a/b.ts`), false);
});

test("store.config.ts 가 기본값 위에 얹히고 supa-store/config 를 풀어 낸다", () => {
  write(
    "store.config.ts",
    `import { defineConfig } from "supa-store/config";
export default defineConfig({ out: "src/gen/x.gen.ts", targets: ["cli"] });`,
  );
  const config = loadConfig(ts, root);
  assert.equal(config.out, `${posix(root)}/src/gen/x.gen.ts`);
  assert.equal(config.enabled("cli"), true);
  assert.equal(config.enabled("tsserver"), false);
});

test("targets 를 적으면 그것만 켜진다", () => {
  write("store.config.ts", `export default { targets: ["cli"] };`);
  const config = loadConfig(ts, root);
  assert.equal(config.enabled("vite"), false);
  assert.equal(config.enabled("cli"), true);
});

test("문법이 깨진 config 는 파일 이름을 담아 실패한다", () => {
  write("store.config.ts", "export default {");
  assert.throws(() => loadConfig(ts, root), /store\.config\.ts/);
});

test("괄호·대괄호가 든 경로의 정의를 찾아 타입을 글자로 쓴다", () => {
  write(
    "src/app/(home)/_state/combination.state.ts",
    `import { createStore } from "supa-store";
createStore("state.home.combination", (set) => ({
  numbers: null as number[] | null,
  choose: (numbers: number[]) => set({ numbers }),
}));`,
  );
  write(
    "src/app/documents/[id]/_state/panel.state.ts",
    `import { createStore } from "supa-store";
createStore("state.documents.[id].panel", (set, get) => ({ open: false, toggle: () => set({ open: !get().open }) }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /^\/\/ 자동 생성 — supa-store 가 쓴다\. 고치지 않는다/);
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
    `import { createStore } from "supa-store";
import type { Pick } from "../../types";
createStore("state.a.last", () => ({ last: null as Pick | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /last: import\("\.\/types"\)\.Pick \| null/);
});

test("함수가 아닌 정의는 건너뛴다", () => {
  write(
    "src/a/_state/odd.state.ts",
    `import { createStore } from "supa-store";
const make = () => ({ n: 0 });
createStore("state.a.odd", make);`,
  );
  generate(ts, loadConfig(ts, root));
  assert.doesNotMatch(read("src/store.gen.ts"), /state\.a\.odd/);
});

test("key 가 변수면 생성이 실패한다", () => {
  write("src/a.state.ts", `import { createStore } from "supa-store";
const k = "a";
createStore(k, () => ({}));`);
  assert.throws(() => generate(ts, loadConfig(ts, root)), /src\/a\.state\.ts: createStore 의 key 는 문자열 그대로 쓴다/);
});

test("템플릿 리터럴 key 도 실패한다", () => {
  write("src/a.state.ts", `import { createStore } from "supa-store";
createStore(\`a\`, () => ({}));`);
  assert.throws(() => generate(ts, loadConfig(ts, root)), /src\/a\.state\.ts: createStore 의 key 는 문자열 그대로 쓴다/);
});

const RES = `import { createStore } from "supa-store";
import { createResource } from "supa-store/query";
`;
const ARRAY_ARGS = /src\/a\.state\.ts: 자원의 args 는 배열로 짓지 않는다 — 여러 값은 객체로 묶는다/;
test("배열 args 를 가진 자원은 실패한다", () => {
  write("src/a.state.ts", `${RES}createStore("a", () => createResource(() => ({ query: async ([from, to]: [number, number]) => from + to })));`);
  assert.throws(() => generate(ts, loadConfig(ts, root)), ARRAY_ARGS);
});
test("배열을 낀 유니온 args 도 실패한다", () => {
  write("src/a.state.ts", `${RES}createStore("a", () => createResource(() => ({ query: async (ids: string[] | undefined) => ids })));`);
  assert.throws(() => generate(ts, loadConfig(ts, root)), ARRAY_ARGS);
});
test("감싼 createResource 도 본다", () => {
  write("src/a.state.ts", `${RES}createStore("a", () => { const r = createResource(() => ({ query: async (ids: string[]) => ids })); return { r }; });`);
  assert.throws(() => generate(ts, loadConfig(ts, root)), ARRAY_ARGS);
});
test("TypeScript 가 isArrayType · isTupleType 을 내주지 않으면 배열 검사를 건너뛴다", () => {
  write("src/a.state.ts", `${RES}createStore("a", () => createResource(() => ({ query: async (ids: string[]) => ids })));`);
  // 옛 TypeScript 를 흉내 낸다 — 검사기에서 두 함수를 뺀다
  const old = {
    ...ts,
    createProgram: (...a) => {
      const program = ts.createProgram(...a);
      const checker = program.getTypeChecker();
      const bare = new Proxy(checker, { get: (t, k) => (k === "isArrayType" || k === "isTupleType" ? undefined : t[k]) });
      return new Proxy(program, { get: (t, k) => (k === "getTypeChecker" ? () => bare : t[k]) });
    },
  };
  assert.doesNotThrow(() => generate(old, loadConfig(ts, root)));
});
test("객체 args 와 인자 없는 query 는 통과한다", () => {
  write("src/a.state.ts", `${RES}createStore("a", () => ({
  r: createResource(() => ({ query: async ({ from, to }: { from: number; to: number }) => from + to })),
  s: createResource(() => ({ query: async () => 1 })),
}));`);
  assert.doesNotThrow(() => generate(ts, loadConfig(ts, root)));
});

test("자원의 select 결과 타입이 생성 파일의 상태 타입에 실린다", () => {
  write("src/a.state.ts", `${RES}createStore("a", () => createResource(() => ({ query: async () => ({ title: "t" }) }), { select: (d) => d.title.length }));`);
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /Resource<void, \{ title: string; \}, \{ query: \(\) => Promise<\{ title: string; \}>; \}, number>/);
});

const COMPILER = { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", skipLibCheck: true, paths: { "supa-store": [storeIndex] } };
const DEF = `import { createStore } from "supa-store";
createStore("state.r.x", () => ({ n: 1 }));`;

test("뿌리 tsconfig 의 references 를 따라 정의를 찾는다", () => {
  write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }));
  write("tsconfig.app.json", JSON.stringify({ compilerOptions: COMPILER, include: ["src"] }));
  write("tsconfig.node.json", JSON.stringify({ compilerOptions: COMPILER, include: ["vite.config.ts"] }));
  write("vite.config.ts", "export default {};");
  write("src/r.state.ts", DEF);
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /"state\.r\.x"/);
});

test("references 가 폴더를 가리켜도 따라간다", () => {
  write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./app" }] }));
  write("app/tsconfig.json", JSON.stringify({ compilerOptions: COMPILER, include: ["../src"] }));
  write("src/r.state.ts", DEF);
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /"state\.r\.x"/);
});

test("어느 참조에도 정의가 없으면 빈 등록부를 쓴다", () => {
  write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
  write("tsconfig.app.json", JSON.stringify({ compilerOptions: COMPILER, include: ["src"] }));
  write("src/plain.ts", "export const a = 1;");
  const config = loadConfig(ts, root);
  generate(ts, config);
  assert.equal(read("src/store.gen.ts"), render([], config));
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
    `import { createStore } from "supa-store";
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
    `import { createStore } from "supa-store";
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
    `import { createStore } from "supa-store";
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
    `import { createStore } from "supa-store";
createStore("state.a.word", () => ({ company: "any" as const, anyway: 1 }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /company: "any"; anyway: number;/);
});

test("createResource 를 돌려주는 정의도 any 없이 찍힌다", () => {
  const tsconfig = JSON.parse(read("tsconfig.json"));
  tsconfig.compilerOptions.paths["supa-store/query"] = [posix(resolve(here, "../src/query.ts"))];
  write("tsconfig.json", JSON.stringify(tsconfig));
  write(
    "src/x/_state/r.state.ts",
    `import { createStore } from "supa-store";
import { createResource } from "supa-store/query";
createStore("api.x.r", () => createResource(() => ({ query: async () => 1 })));`,
  );
  generate(ts, loadConfig(ts, root));
  const line = read("src/store.gen.ts").split("\n").find((l) => l.includes('"api.x.r"'));
  assert.ok(line, "api.x.r 가 찍힌다");
  assert.doesNotMatch(line, /\bany\b/);
});

test("createStream 을 돌려주는 정의의 상태 타입도 any 없이 찍힌다", () => {
  const tsconfig = JSON.parse(read("tsconfig.json"));
  tsconfig.compilerOptions.paths["supa-store/stream"] = [posix(resolve(here, "../src/stream/index.ts"))];
  write("tsconfig.json", JSON.stringify(tsconfig));
  write(
    "src/x/_state/s.state.ts",
    `import { createStore } from "supa-store";
import { createStream } from "supa-store/stream";
createStore("infra.s", () => createStream<string, { chunk: string }, { open(cwd: string): string }>({ url: "ws://x", reduce: (o, c) => o + c.chunk, commands: { open: {} } }));`,
  );
  generate(ts, loadConfig(ts, root));
  const line = read("src/store.gen.ts").split("\n").find((l) => l.includes('"infra.s"'));
  assert.ok(line, "infra.s 가 찍힌다");
  assert.doesNotMatch(line, /\bany\b/);
  assert.match(line, /open/);
});

// 소비자처럼 supa-store 를 node_modules 로만 닿게 한다 — 지은 dist 와 실제 exports 를 가진 package.json 을 복사한다
const installed = (pkgDir) => {
  cpSync(resolve(here, "../dist"), join(root, pkgDir, "dist"), { recursive: true });
  cpSync(resolve(here, "../package.json"), join(root, pkgDir, "package.json"));
};
const NM_DEFS = `import { createStore } from "supa-store";
import { createResource, createEvent } from "supa-store/query";
import { createStream } from "supa-store/stream";
createStore("api.r", () => createResource(() => ({ query: async () => 1 })));
createStore("ui.e", (set, get, ctx) => ({ changed: createEvent<number>(), ctx }));
createStore("infra.s", () => createStream<string, { chunk: string }>({ url: "ws://x", reduce: (o, c) => o + c.chunk }));
`;
const nodeModulesProject = () => {
  write("tsconfig.json", JSON.stringify({ compilerOptions: { ...COMPILER, paths: undefined }, include: ["src"] }));
};
// 생성 파일이 그 프로젝트 안에서 타입 검사를 통과하는가
const genDiagnostics = () => {
  const { config, error } = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert.equal(error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const gen = program.getSourceFiles().find((f) => f.fileName.endsWith("/src/store.gen.ts"));
  return ts.getPreEmitDiagnostics(program, gen).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
};
const NO_PATH = /import\("(?:[A-Za-z]:)?\/|node_modules|\bany\b/;

test("node_modules 로 깐 supa-store 의 자원·사건·흐름 정의도 패키지 이름으로 찍힌다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("src/a.state.ts", NM_DEFS);
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /"api\.r": import\("supa-store\/query"\)\.Resource</);
  assert.match(out, /changed: import\("supa-store\/query"\)\.Event<number>/);
  assert.match(out, /ctx: import\("supa-store"\)\.Ctx/);
  assert.match(out, /"infra\.s": import\("supa-store\/stream"\)\.Stream</);
  assert.doesNotMatch(out, NO_PATH);
  assert.deepEqual(genDiagnostics(), []);
});

test("pnpm 의 .pnpm 자리에 깔린 supa-store 도 패키지 이름으로 찍힌다", () => {
  nodeModulesProject();
  const real = "node_modules/.pnpm/supa-store@0.3.0/node_modules/supa-store";
  installed(real);
  symlinkSync(join(root, real), join(root, "node_modules/supa-store"), "junction");
  write("src/a.state.ts", NM_DEFS);
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /"api\.r": import\("supa-store\/query"\)\.Resource</);
  assert.match(out, /"infra\.s": import\("supa-store\/stream"\)\.Stream</);
  assert.doesNotMatch(out, NO_PATH);
  assert.deepEqual(genDiagnostics(), []);
});

test("다른 패키지의 타입은 그 패키지의 exports 하위 경로로 찍고 맞는 것이 없으면 패키지 이름만 쓴다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write(
    "node_modules/@fake/lib/package.json",
    JSON.stringify({
      name: "@fake/lib",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./sub": { import: { types: "./lib/sub.d.mts", default: "./lib/sub.mjs" } },
      },
    }),
  );
  write("node_modules/@fake/lib/index.d.ts", `export type Root = { r: 1 };\nexport type { Hidden } from "./lib/hidden";`);
  write("node_modules/@fake/lib/lib/sub.d.mts", "export type Thing = { id: string };");
  write("node_modules/@fake/lib/lib/hidden.d.ts", "export type Hidden = { h: 1 };");
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { Root, Hidden } from "@fake/lib";
import type { Thing } from "@fake/lib/sub";
createStore("ui.x", () => ({ root: null as Root | null, thing: null as Thing | null, hidden: null as Hidden | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /root: import\("@fake\/lib"\)\.Root \| null/);
  assert.match(out, /thing: import\("@fake\/lib\/sub"\)\.Thing \| null/);
  assert.match(out, /hidden: import\("@fake\/lib"\)\.Hidden \| null/); // exports 에 없는 파일
  assert.doesNotMatch(out, NO_PATH);
  assert.deepEqual(genDiagnostics(), []);
});

// 공개 진입이 다른 파일에 선언된 타입을 다시 내보내는 경우 — 선언 파일이 아니라 그 이름을 내보내는 진입으로 찍는다
const REEXPORT_DEFS = `import { createStore } from "supa-store";
import type { RefetchInterval } from "supa-store/query";
import type { ClientView, CommandError } from "supa-store/stream";
createStore("p.cv", () => ({ view: null as ClientView<string> | null, err: null as CommandError | null, iv: 5 as RefetchInterval<number> }));
`;
const assertReexports = () => {
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /view: import\("supa-store\/stream"\)\.ClientView<string>/);
  assert.match(out, /err: import\("supa-store\/stream"\)\.CommandError/);
  assert.match(out, /iv: import\("supa-store\/query"\)\.RefetchInterval<number>/);
  assert.doesNotMatch(out, NO_PATH);
  assert.deepEqual(genDiagnostics(), []);
};
test("다시 내보낸 타입은 그 이름을 내보내는 진입으로 찍힌다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("src/a.state.ts", REEXPORT_DEFS);
  assertReexports();
});
test("pnpm 자리에서도 다시 내보낸 타입을 그 진입으로 찍는다", () => {
  nodeModulesProject();
  const real = "node_modules/.pnpm/supa-store@0.3.0/node_modules/supa-store";
  installed(real);
  symlinkSync(join(root, real), join(root, "node_modules/supa-store"), "junction");
  write("src/a.state.ts", REEXPORT_DEFS);
  assertReexports();
});

// 가짜 패키지 — 진입 index 가 내부 파일의 이름을 다른 이름으로, 또는 별로 다시 내보낸다
const fakePackage = (exportsMap) => {
  write("node_modules/fake/package.json", JSON.stringify({ name: "fake", exports: exportsMap }));
  write("node_modules/fake/index.d.ts", `export type { Inner as Outer } from "./lib/inner.js";\nexport * from "./lib/star.js";`);
  write("node_modules/fake/lib/inner.d.ts", "export type Inner = { i: 1 };\nexport type Secret = { s: 1 };");
  write("node_modules/fake/lib/star.d.ts", "export interface Starred { st: 1 }");
};
test("다른 이름으로 다시 내보낸 타입은 그 이름으로 찍고 export * 도 따라간다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  fakePackage({ ".": { types: "./index.d.ts" } });
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { Outer, Starred } from "fake";
createStore("ui.f", () => ({ o: null as Outer | null, s: null as Starred | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /o: import\("fake"\)\.Outer \| null/);
  assert.match(out, /s: import\("fake"\)\.Starred \| null/);
  assert.doesNotMatch(out, /Inner/);
  assert.deepEqual(genDiagnostics(), []);
});
test("어느 진입도 내보내지 않는 타입을 쓰면 key · 이름 · 파일을 담아 실패한다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  fakePackage({ ".": { types: "./index.d.ts" } });
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { Secret } from "fake/lib/inner";
createStore("ui.f", () => ({ s: null as Secret | null }));`,
  );
  write("tsconfig.json", JSON.stringify({ compilerOptions: { ...COMPILER, paths: { "fake/lib/inner": ["./node_modules/fake/lib/inner.d.ts"] } }, include: ["src"] }));
  assert.throws(
    () => generate(ts, loadConfig(ts, root)),
    (e) => /ui\.f/.test(e.message) && /Secret/.test(e.message) && /fake\/lib\/inner/.test(e.message),
  );
});
test("exports 의 null 로 막은 경로는 고르지 않는다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  fakePackage({ "./internal/inner": null, "./internal/*": "./lib/*.d.ts", "./x": { types: "./lib/inner.d.ts" } });
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { Inner } from "fake/x";
createStore("ui.f", () => ({ i: null as Inner | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /i: import\("fake\/x"\)\.Inner \| null/);
  assert.deepEqual(genDiagnostics(), []);
});
// 다이아몬드 — 층마다 두 파일이 다음 층 둘을 export * 한다. back 은 층 파일마다 꼭대기로 되돌아가는 간선(순환)
for (const [label, back] of [
  ["순환 없는", ""],
  ["꼭대기로 export * 하는", `export * from "./index.js";
`],
  ["꼭대기에서 import type 하는", `import type { Top } from "./index.js";
export type TopAlias = Top;
`],
]) {
  test(`${label} 다이아몬드 구조도 파일마다 한 번만 읽고 이름을 빠뜨리지 않는다`, () => {
    nodeModulesProject();
    installed("node_modules/supa-store");
    const DEPTH = 10;
    write("node_modules/dia/package.json", JSON.stringify({ name: "dia", exports: { ".": { types: "./index.d.ts" } } }));
    write("node_modules/dia/index.d.ts", `export * from "./l0a.js";
export * from "./l0b.js";
export interface Top { t: 1 }`);
    for (let i = 0; i < DEPTH; i++)
      for (const side of ["a", "b"])
        write(
          `node_modules/dia/l${i}${side}.d.ts`,
          back + (i + 1 < DEPTH ? `export * from "./l${i + 1}a.js";
export * from "./l${i + 1}b.js";
` : "export interface Bottom { b: 1 }\n") + `export interface N${i}${side} { n: 1 }
`,
        );
    write(
      "src/a.state.ts",
      `import { createStore } from "supa-store";
import type { Bottom, N3b } from "dia";
createStore("ui.d", () => ({ b: null as Bottom | null, n: null as N3b | null }));`,
    );
    // 이 패키지의 파일을 몇 번 읽는지 센다 — 컴파일러가 따로 읽는 것은 세지 않는다
    let parses = 0;
    const counted = Object.create(ts, {
      createSourceFile: { value: (name, ...rest) => (/^(?:l\d+[ab]|index)\.d\.ts$/.test(name) && parses++, ts.createSourceFile(name, ...rest)) },
    });
    generate(counted, loadConfig(ts, root));
    const out = read("src/store.gen.ts");
    assert.match(out, /b: import\("dia"\)\.Bottom \| null/);
    assert.match(out, /n: import\("dia"\)\.N3b \| null/);
    assert.equal(parses, 1 + 2 * DEPTH);
    assert.deepEqual(genDiagnostics(), []);
  });
}
test("서로 export * 하는 순환에서도 이름을 빠뜨리지 않는다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("node_modules/cy2/package.json", JSON.stringify({ name: "cy2", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/cy2/index.d.ts", `export * from "./a.js";`);
  write("node_modules/cy2/a.d.ts", `export * from "./b.js";
export interface IA { a: 1 }`);
  write("node_modules/cy2/b.d.ts", `export * from "./a.js";
export * from "./c.js";
export interface IB { b: 1 }`);
  write("node_modules/cy2/c.d.ts", `export * from "./a.js";
export interface IC { c: 1 }`);
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { IA, IB, IC } from "cy2";
createStore("ui.c", () => ({ a: null as IA | null, b: null as IB | null, c: null as IC | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  for (const n of ["IA", "IB", "IC"]) assert.match(out, new RegExp(`import\\("cy2"\\)\\.${n} \\| null`));
  assert.deepEqual(genDiagnostics(), []);
});
test("진입 파일 자신에 선언된 export = 의 네임스페이스 · export default 도 그 진입으로 찍는다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("node_modules/eq/package.json", JSON.stringify({ name: "eq", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/eq/index.d.ts", "declare function eq(): void;\ndeclare namespace eq { interface Opts { a: 1 } }\nexport = eq;");
  write("node_modules/defi/package.json", JSON.stringify({ name: "defi", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/defi/index.d.ts", "export default interface Conf { c: 1 }");
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type eq from "eq";
import type Conf from "defi";
createStore("ui.q", () => ({ o: null as eq.Opts | null, c: null as Conf | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /o: import\("eq"\)\.Opts \| null/);
  assert.match(out, /c: import\("defi"\)\.default \| null/);
  assert.deepEqual(genDiagnostics(), []);
});
test("프로젝트가 node_modules 아래에 있어도 프로젝트 안 파일은 상대 경로로 둔다", () => {
  const outer = root;
  root = join(outer, "node_modules", "app");
  try {
    write("package.json", "{}");
    nodeModulesProject();
    installed("node_modules/supa-store");
    write("src/types.ts", "export type Pick = { p: 1 };");
    write(
      "src/a.state.ts",
      `import { createStore } from "supa-store";
import type { Pick } from "./types";
createStore("ui.p", () => ({ p: null as Pick | null }));`,
    );
    generate(ts, loadConfig(ts, root));
    const out = read("src/store.gen.ts");
    assert.match(out, /p: import\("\.\/types"\)\.Pick \| null/);
    assert.deepEqual(genDiagnostics(), []);
  } finally {
    root = outer;
  }
});
test("export * as ns 로만 닿는 타입은 ns 를 거쳐 찍고 대상의 재내보내기도 따라간다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("node_modules/nsx/package.json", JSON.stringify({ name: "nsx", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/nsx/index.d.ts", `export * as inner from "./inner.js";`);
  write("node_modules/nsx/inner.d.ts", `export interface Deep { d: 1 }\nexport * from "./more.js";`);
  write("node_modules/nsx/more.d.ts", "export interface More { m: 1 }");
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { inner } from "nsx";
createStore("ui.n", () => ({ d: null as inner.Deep | null, m: null as inner.More | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /d: import\("nsx"\)\.inner\.Deep \| null/);
  assert.match(out, /m: import\("nsx"\)\.inner\.More \| null/);
  assert.doesNotMatch(out, NO_PATH);
  assert.deepEqual(genDiagnostics(), []);
});
test("같은 이름이 이름 붙은 길로도 나가면 ns 길보다 그것을 쓴다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  // 앞선 진입은 ns 로만, 뒤의 진입은 이름 그대로 내보낸다
  write("node_modules/nsx/package.json", JSON.stringify({ name: "nsx", exports: { ".": { types: "./index.d.ts" }, "./flat": { types: "./flat.d.ts" } } }));
  write("node_modules/nsx/index.d.ts", `export * as inner from "./inner.js";`);
  write("node_modules/nsx/flat.d.ts", `export type { Deep } from "./inner.js";`);
  write("node_modules/nsx/inner.d.ts", "export interface Deep { d: 1 }");
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { inner } from "nsx";
createStore("ui.n", () => ({ d: null as inner.Deep | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /d: import\("nsx\/flat"\)\.Deep \| null/);
  assert.deepEqual(genDiagnostics(), []);
});

// 기본 타입 인자에 any 를 품은 라이브러리 타입 — React.ReactElement 의 JSXElementConstructor<any> 와 같은 꼴
const anyDefaultPackage = () => {
  write("node_modules/el/package.json", JSON.stringify({ name: "el", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/el/index.d.ts", "export type Ctor<P> = (props: P) => null;\nexport interface El<T = Ctor<any>> { type: T }");
};
test("반환 타입을 적은 정의는 라이브러리 기본 타입 인자의 any 를 거부하지 않는다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  anyDefaultPackage();
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { El } from "el";
createStore("ui.el", (set, get, ctx): { el: El | null } => ({ el: null }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /"ui\.el": \{ el: import\("el"\)\.El<.*any.*> \| null; \};/);
  assert.deepEqual(genDiagnostics(), []);
});
test("반환 타입이 없으면 같은 필드도 any 로 거부한다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  anyDefaultPackage();
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { El } from "el";
createStore("ui.el", () => ({ el: null as El | null }));`,
  );
  assert.throws(() => generate(ts, loadConfig(ts, root)), (e) => /ui\.el/.test(e.message) && /any 가 남는다/.test(e.message));
});
test("자기에게 export * as 하는 순환에서도 점이 가장 적은 ns 길을 찍는다", () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("node_modules/cyc/package.json", JSON.stringify({ name: "cyc", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/cyc/index.d.ts", `export * as s0 from "./index.js";\nexport * as inner from "./inner.js";`);
  write("node_modules/cyc/inner.d.ts", "export interface X { x: 1 }");
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { inner } from "cyc";
createStore("ui.c", () => ({ x: null as inner.X | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  assert.match(read("src/store.gen.ts"), /x: import\("cyc"\)\.inner\.X \| null/);
  assert.deepEqual(genDiagnostics(), []);
});
test("갈래 둘의 ns 순환이 파일 스물을 거쳐도 열쇠가 불지 않고 곧바로 끝난다", { timeout: 30000 }, () => {
  nodeModulesProject();
  installed("node_modules/supa-store");
  write("node_modules/cyc/package.json", JSON.stringify({ name: "cyc", exports: { ".": { types: "./index.d.ts" } } }));
  write("node_modules/cyc/index.d.ts", `export * from "./f0.js";`);
  for (let i = 0; i < 20; i++) {
    const tail = i < 19 ? `export * from "./f${i + 1}.js";` : `export * as inner from "./leaf.js";`;
    write(`node_modules/cyc/f${i}.d.ts`, `export * as s0 from "./f${i}.js";\nexport * as s1 from "./f${i}.js";\n${tail}\nexport interface I${i} { i: ${i} }`);
  }
  write("node_modules/cyc/leaf.d.ts", "export interface Deep { d: 1 }");
  write(
    "src/a.state.ts",
    `import { createStore } from "supa-store";
import type { I7, inner } from "cyc";
createStore("ui.c", () => ({ i: null as I7 | null, d: null as inner.Deep | null }));`,
  );
  generate(ts, loadConfig(ts, root));
  const out = read("src/store.gen.ts");
  assert.match(out, /i: import\("cyc"\)\.I7 \| null/);
  assert.match(out, /d: import\("cyc"\)\.inner\.Deep \| null/);
  assert.deepEqual(genDiagnostics(), []);
});
