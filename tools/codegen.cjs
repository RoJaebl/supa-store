// 생성기 핵심 — CLI·Next 래퍼·tsserver 플러그인이 함께 쓴다. 플러그인이 CommonJS 여야 하므로 이 파일도 CommonJS 다
const { createRequire } = require("node:module");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, dirname, join, relative, resolve } = require("node:path");

// src/config.ts 의 defaults 와 같다 — dist 는 ESM 이라 여기서 부를 수 없다
const defaults = { include: ["src/**/*.state.ts"], out: "src/store.gen.ts", targets: ["tsserver", "next", "vite", "cli"] };
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
    const req = (id) => (id === "supa-store/config" ? { defineConfig: (c) => c } : projectRequire(id));
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
  // node_modules 안의 타입(supa-store 자신의 Resource 포함)은 이 깃발 없이는 글자로 옮기지 못하고 undefined 가 된다
  const flags =
    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType | ts.NodeBuilderFlags.AllowNodeModulesRelativePaths;
  const entries = [];
  const broken = [];
  const loose = [];
  const arrayArgs = [];
  // query 의 첫 매개변수가 배열·튜플(유니온의 한 갈래 포함)인가 — 읽지 못하면 아니라고 본다
  const isArrayArgs = (call) => {
    // 옛 TypeScript 는 두 검사 함수를 내주지 않는다 — 읽지 못하면 건너뛴다
    if (typeof checker.isArrayType !== "function" || typeof checker.isTupleType !== "function") return false;
    const fn = call.arguments[0];
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    const def = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(fn));
    const query = def.getProperty("query");
    const param = query && checker.getTypeOfSymbolAtLocation(query, fn).getCallSignatures()[0]?.parameters[0];
    if (!param) return false;
    const type = checker.getTypeOfSymbolAtLocation(param, fn);
    return (type.isUnion() ? type.types : [type]).some((t) => checker.isArrayType(t) || checker.isTupleType(t));
  };
  for (const source of program.getSourceFiles()) {
    if (!config.match(source.fileName)) continue;
    // 문법이 깨진 정의는 반환 타입이 any 로 무너진다 — 그것을 쓰면 타입 검사가 조용히 꺼지므로 아예 짓지 않는다
    if (program.getSyntacticDiagnostics(source).length) {
      broken.push(posix(source.fileName));
      continue;
    }
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createResource" && isArrayArgs(node)) {
        arrayArgs.push(posix(source.fileName));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createStore") {
        const [key, fn] = node.arguments;
        // 변수·템플릿 key 는 등록부에 실을 수 없다 — 조용히 건너뛰면 타입이 없는 채로 남으므로 실패시킨다
        if (key && !ts.isStringLiteral(key)) loose.push(posix(source.fileName));
        else if (key && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(fn));
          const typeNode = checker.typeToTypeNode(type, undefined, flags);
          if (!typeNode) throw new Error(`${key.text}(${posix(source.fileName)}) 의 타입을 글자로 옮기지 못한다 — 반환 타입을 적는다`);
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
  if (loose.length) throw new Error(`${[...new Set(loose)].map((f) => posix(relative(config.root, f))).join(", ")}: createStore 의 key 는 문자열 그대로 쓴다`);
  if (arrayArgs.length) throw new Error(`${[...new Set(arrayArgs)].map((f) => posix(relative(config.root, f))).join(", ")}: 자원의 args 는 배열로 짓지 않는다 — 여러 값은 객체로 묶는다`);
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function relativeFromOut(config, file) {
  const rel = posix(relative(dirname(config.out), file));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// node_modules/<패키지>/… 의 파일 경로를 패키지 이름 + exports 하위 경로로 바꾼다. 패키지 밖이면 null
function packageSpecifier(spec) {
  // 마지막 node_modules 가 패키지 자리다 — pnpm 의 .pnpm/<이름>@<판>/node_modules/<이름> 도 이것으로 풀린다
  const m = /^(.*\/node_modules\/)((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(spec);
  if (!m) return null;
  const [, base, dir, rest] = m;
  // @types/foo 는 foo, @types/scope__pkg 는 @scope/pkg 로 쓴다
  const name = dir.startsWith("@types/") ? dir.slice(7).replace(/^(.+)__/, "@$1/") : dir;
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(`${base}${dir}/package.json`, "utf8"));
  } catch {}
  const bare = (p) => posix(p).replace(/^\.\//, "").replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
  const file = bare(rest);
  if (!pkg.exports) {
    // exports 가 없으면 깊은 경로가 그대로 풀린다 — 진입 파일이면 이름만 쓴다
    const entry = bare(pkg.types ?? pkg.typings ?? pkg.main ?? "index");
    return file === entry || file === "index" ? name : `${name}/${file}`;
  }
  const exp = pkg.exports;
  const map = typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith(".")) ? exp : { ".": exp };
  // 조건이 겹친 대상(import.types 같은 것)과 배열까지 끝의 글자를 모두 모은다
  const targets = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(targets) : []);
  for (const [sub, value] of Object.entries(map)) {
    const subpath = sub.replace(/^\.\/?/, "");
    for (const target of targets(value).map(bare)) {
      const [head, tail] = target.split("*");
      if (tail === undefined ? target !== file : !(file.startsWith(head) && file.endsWith(tail) && file.length >= head.length + tail.length)) continue;
      const hit = tail === undefined ? subpath : subpath.replace("*", file.slice(head.length, file.length - tail.length));
      return hit ? `${name}/${hit}` : name;
    }
  }
  return name;
}

function render(entries, config) {
  const files = [...new Set(entries.map((e) => e.file))];
  const types = entries.map((e) => {
    const text = e.text.replace(/import\("([^"]+)"\)/g, (whole, spec) =>
      /^(?:[A-Za-z]:)?\//.test(spec) ? `import("${packageSpecifier(spec) ?? relativeFromOut(config, spec)}")` : whole,
    );
    return `    ${JSON.stringify(e.key)}: ${text};`;
  });
  return [
    "// 자동 생성 — supa-store 가 쓴다. 고치지 않는다",
    "export {};",
    ...files.map((f) => `import "${relativeFromOut(config, f).replace(/\.ts$/, "")}";`),
    "",
    'declare module "supa-store" {',
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
  const parse = (tsconfig) => {
    const { config: json, error } = ts.readConfigFile(tsconfig, ts.sys.readFile);
    const fail = (d) => new Error(`${basename(tsconfig)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    if (error) throw fail(error);
    const parsed = ts.parseJsonConfigFileContent(json, ts.sys, dirname(tsconfig), undefined, tsconfig);
    // 정의가 하나도 없으면 「No inputs were found」(18003) 가 나지만 빈 등록부를 써야 하므로 그것만 넘긴다
    const real = parsed.errors.filter((d) => d.code !== 18003);
    if (real.length) throw fail(real[0]);
    return parsed;
  };
  let parsed = parse(join(config.root, "tsconfig.json"));
  // 뿌리가 files: [] + references 뿐인 솔루션 스타일이면 참조한 설정 가운데 정의 파일을 가진 첫 것을 쓴다
  if (!parsed.fileNames.some(config.match) && parsed.projectReferences?.length) {
    for (const ref of parsed.projectReferences) {
      const sub = parse(ts.resolveProjectReferencePath(ref));
      if (sub.fileNames.some(config.match)) {
        parsed = sub;
        break;
      }
    }
  }
  const { fileNames, options } = parsed;
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
