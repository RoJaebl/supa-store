// 생성기 핵심 — CLI·Next 래퍼·tsserver 플러그인이 함께 쓴다. 플러그인이 CommonJS 여야 하므로 이 파일도 CommonJS 다
const { createRequire } = require("node:module");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

// src/config.ts 의 defaults 와 같다 — dist 는 ESM 이라 여기서 부를 수 없다
const defaults = { include: ["src/**/*.state.ts"], out: "src/store.gen.ts", targets: ["tsserver"] };
const CONFIG_FILE = "store.config.ts";

const posix = (p) => p.replace(/\\/g, "/");

function requireTypeScript(root) {
  return createRequire(join(root, "package.json"))("typescript");
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
  const pattern = new RegExp(`^${globToSource(root)}/(?:${merged.include.map(globToSource).join("|")})$`);
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
  for (const source of program.getSourceFiles()) {
    if (!config.match(source.fileName)) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createStore") {
        const [key, fn] = node.arguments;
        if (key && ts.isStringLiteral(key) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(fn));
          const typeNode = checker.typeToTypeNode(type, undefined, flags);
          const text = printer.printNode(ts.EmitHint.Unspecified, typeNode, source).replace(/\r?\n\s*/g, " ");
          entries.push({ file: posix(source.fileName), key: key.text, text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
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
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  // 정의가 하나도 없으면 「No inputs were found」 진단이 나지만 빈 등록부를 써야 하므로 진단은 보지 않는다
  const { fileNames, options } = ts.parseJsonConfigFileContent(json, ts.sys, config.root, undefined, tsconfig);
  const program = ts.createProgram({ rootNames: fileNames, options });
  return writeIfChanged(config.out, render(collect(ts, program, config), config));
}

module.exports = { loadConfig, collect, render, generate, writeIfChanged, requireTypeScript };
