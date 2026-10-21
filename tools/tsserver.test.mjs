// 실제 tsserver 를 띄워 플러그인이 정의를 고친 바로 그 요청에서 타입을 따라잡는지 본다.
// plugin.test.mjs 는 맨 LanguageService 를 쓰는데, 그것은 요청마다 판본을 물어 이 지연을 드러내지 못한다
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const posix = (p) => p.replace(/\\/g, "/");
const repo = resolve(here, "../../..");
const storeIndex = posix(resolve(here, "../src/index.ts"));
// 이 패키지가 devDependency 로 가진 TypeScript 의 tsserver 다
const tsserverJs = createRequire(import.meta.url).resolve("typescript/lib/tsserver.js");

let root;
const write = (rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  root = posix(mkdtempSync(join(tmpdir(), "store-tsserver-")));
  write("package.json", "{}");
  write("store.config.ts", `export default { targets: ["tsserver"] };`);
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
        plugins: [{ name: "@fortuna-lottery/store/tools/plugin.cjs" }],
      },
      include: ["src"],
    }),
  );
});
// Windows 에서는 끝난 tsserver 의 감시 핸들이 늦게 풀릴 수 있어 몇 번 다시 지운다
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** tsserver 하나를 띄운다. 플러그인은 저장소 뿌리의 node_modules 에서 찾게 한다 */
function startServer() {
  const child = spawn(
    process.execPath,
    [tsserverJs, "--pluginProbeLocations", posix(repo), "--disableAutomaticTypingAcquisition"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let seq = 0;
  let buf = Buffer.alloc(0);
  let stderr = "";
  const waiting = new Map();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  // tsserver 가 죽으면 기다리던 요청을 모두 그 까닭과 함께 실패시킨다 — 시간 초과까지 매달리지 않게
  child.on("exit", (code) => {
    for (const [, { reject }] of waiting) reject(new Error(`tsserver 가 끝났다(code ${code}): ${stderr}`));
    waiting.clear();
  });
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const head = buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, head).toString())[1]);
      if (buf.length < head + 4 + len) return;
      const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
      buf = buf.subarray(head + 4 + len);
      if (msg.type === "response" && waiting.has(msg.request_seq)) {
        waiting.get(msg.request_seq).resolve(msg);
        waiting.delete(msg.request_seq);
      }
    }
  });
  const send = (command, args) =>
    new Promise((resolve, reject) => {
      const s = ++seq;
      waiting.set(s, { resolve, reject });
      child.stdin.write(JSON.stringify({ seq: s, type: "request", command, arguments: args }) + "\n");
    });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await once(child, "exit");
  };
  return { send, stop };
}

const DEF = (body) => `import { createStore } from "@fortuna-lottery/store";
createStore("state.a.count", (set) => ({ ${body} }));
`;
const USE = `import "./store.gen";
import { getStore } from "@fortuna-lottery/store";
export const label = getStore("state.a.count").getState().label;
`;

test("저장하지 않은 정의를 고치면 바로 그 다음 진단에서 새 필드를 안다", { timeout: 60000 }, async () => {
  write("src/a/_state/count.state.ts", DEF("n: 0"));
  write("src/use.ts", USE);
  const def = `${root}/src/a/_state/count.state.ts`;
  const use = `${root}/src/use.ts`;
  const server = startServer();
  try {
    await server.send("open", { file: def, projectRootPath: root });
    await server.send("open", { file: use, projectRootPath: root });
    const diag = async () => {
      const r = await server.send("semanticDiagnosticsSync", { file: use });
      if (!r.success) throw new Error(r.message);
      return r.body.map((d) => d.text);
    };
    assert.ok((await diag()).some((t) => /label/.test(t)));

    await server.send("change", {
      file: def,
      line: 2,
      offset: 1,
      endLine: 3,
      endOffset: 1,
      insertString: `createStore("state.a.count", (set) => ({ n: 0, label: "x" }));\n`,
    });
    assert.deepEqual(await diag(), []); // 한 박자 늦어 다음 편집을 기다리면 여기서 label 오류가 남는다
    assert.match(readFileSync(join(root, "src/store.gen.ts"), "utf8"), /label: string/);
  } finally {
    await server.stop();
  }
});
