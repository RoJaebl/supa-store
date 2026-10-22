// 생성기 핵심 — CLI·Next 래퍼·tsserver 플러그인이 함께 쓴다. 플러그인이 CommonJS 여야 하므로 이 파일도 CommonJS 다
const { createRequire } = require("node:module");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

// src/config.ts 의 defaults 와 같다 — dist 는 ESM 이라 여기서 부를 수 없다
const defaults = { include: ["src/**/*.state.ts"], out: "src/store.gen.ts", targets: ["tsserver"] };
const CONFIG_FILE = "store.config.ts";
const MAX_ROUNDS = 5;

const posix = (p) => p.replace(/\\/g, "/");

function requireTypeScript(root) {
  try {
    return createRequire(join(root, "package.json"))("typescript");
  } catch {
    // 프로젝트 자리에서 풀리지 않으면 이 패키지 곁의 것(peer 로 함께 깔린 것)을 쓴다
    return require("typescript");
  }
}

function globToSource(glob) {
  return posix(glob)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, "(?:.*/)?");
}

function readUserConfig(ts, root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return {};
  try {
    const { outputText, diagnostics = [] } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
      fileName: CONFIG_FILE,
      reportDiagnostics: true,
    });
    if (diagnostics.length) throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n"));
    const projectRequire = createRequire(join(root, "package.json"));
    const req = (id) => (id === "@fortuna-lottery/store/config" ? { defineConfig: (c) => c } : projectRequire(id));
    const module = { exports: {} };
    new Function("exports", "require", "module", outputText)(module.exports, req, module);
    return module.exports.default ?? module.exports;
  } catch (error) {
    throw new Error(`${CONFIG_FILE}: ${error.message}`);
  }
}

function loadConfig(ts, fromDir) {
  const found = ts.findConfigFile(posix(fromDir), ts.sys.fileExists, "package.json");
  if (!found) throw new Error(`package.json 을 찾지 못했다: ${fromDir}`);
  const root = posix(dirname(resolve(found)));
  const merged = { ...defaults, ...readUserConfig(ts, root) };
  // Windows 는 경로의 대소문자를 가리지 않고, tsserver 는 드라이브 글자를 소문자(c:/…)로 넘기곤 한다
  const pattern = new RegExp(
    `^${globToSource(root)}/(?:${merged.include.map(globToSource).join("|")})$`,
    process.platform === "win32" ? "i" : "",
  );
  return {
    root,
    out: posix(resolve(root, merged.out)),
    match: (file) => pattern.test(posix(file)),
    enabled: (target) => merged.targets.includes(target),
  };
}

function collect(ts, program, config) {
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true });
  const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType;
  const entries = [];
  const broken = [];
  for (const source of program.getSourceFiles()) {
    if (!config.match(source.fileName)) continue;
    // 문법이 깨진 정의는 반환 타입이 any 로 무너진다 — 그것을 쓰면 타입 검사가 조용히 꺼지므로 아예 짓지 않는다
    if (program.getSyntacticDiagnostics(source).length) {
      broken.push(posix(source.fileName));
      continue;
    }
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createStore") {
        const [key, fn] = node.arguments;
        if (key && ts.isStringLiteral(key) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(fn));
          const typeNode = checker.typeToTypeNode(type, undefined, flags);
          const text = printer.printNode(ts.EmitHint.Unspecified, typeNode, source).replace(/\r?\n\s*/g, " ");
          const hasAny = (n) => n.kind === ts.SyntaxKind.AnyKeyword || !!ts.forEachChild(n, hasAny);
          entries.push({ file: posix(source.fileName), key: key.text, text, any: hasAny(typeNode) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (broken.length) throw new Error(`정의 파일의 문법이 깨져 생성 파일을 쓰지 않는다: ${broken.join(", ")}`);
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function relativeFromOut(config, file) {
  const rel = posix(relative(dirname(config.out), file));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function render(entries, config) {
  const files = [...new Set(entries.map((e) => e.file))];
  const types = entries.map((e) => {
    const text = e.text.replace(/import\("([^"]+)"\)/g, (whole, spec) =>
      /^(?:[A-Za-z]:)?\//.test(spec) ? `import("${relativeFromOut(config, spec)}")` : whole,
    );
    return `    ${JSON.stringify(e.key)}: ${text};`;
  });
  return [
    "// 자동 생성 — @fortuna-lottery/store 가 쓴다. 고치지 않는다",
    "export {};",
    ...files.map((f) => `import "${relativeFromOut(config, f).replace(/\.ts$/, "")}";`),
    "",
    'declare module "@fortuna-lottery/store" {',
    "  interface StateTypes {",
    ...types,
    "  }",
    "}",
    "",
  ].join("\n");
}

function writeIfChanged(file, text) {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}

function generate(ts, config) {
  const tsconfig = join(config.root, "tsconfig.json");
  const { config: json, error } = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const fail = (d) => new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  if (error) throw fail(error);
  const { fileNames, options, errors } = ts.parseJsonConfigFileContent(json, ts.sys, config.root, undefined, tsconfig);
  // 정의가 하나도 없으면 「No inputs were found」(18003) 가 나지만 빈 등록부를 써야 하므로 그것만 넘긴다
  const real = errors.filter((d) => d.code !== 18003);
  if (real.length) throw fail(real[0]);
  // 생성 내용을 가상 파일로 넣고 다시 뽑기를 되풀이한다. 새 key 의 첫 돌기에는 StateOf 가 unknown 이라
  // get() 에 기대는 함수가 any 로 찍히는데, 그 결과를 넣은 다음 돌기가 바로잡는다
  const same = (p) => posix(p).toLowerCase();
  const out = same(config.out);
  const rootNames = fileNames.some((f) => same(f) === out) ? fileNames : [...fileNames, config.out];
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  let text = existsSync(config.out) ? readFileSync(config.out, "utf8") : render([], config);
  host.getSourceFile = (file, lang, ...rest) =>
    same(file) === out ? ts.createSourceFile(file, text, lang) : getSourceFile(file, lang, ...rest);
  let program;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    program = ts.createProgram({ rootNames, options, host, oldProgram: program });
    const entries = collect(ts, program, config);
    const next = render(entries, config);
    if (next === text) {
      const bad = entries.find((e) => e.any);
      // 고정점에도 any 가 남으면 그 key 의 타입 검사가 조용히 꺼진다 — 쓰지 않고 반환 타입을 적게 한다
      if (bad) throw new Error(`${bad.key}(${bad.file}) 의 타입에 any 가 남는다 — 반환 타입을 적는다`);
      return writeIfChanged(config.out, text);
    }
    text = next;
  }
  throw new Error(`생성 결과가 ${MAX_ROUNDS} 번 돌아도 멈추지 않는다 — 정의의 반환 타입을 적는다`);
}

module.exports = { loadConfig, collect, render, generate, writeIfChanged, requireTypeScript };
