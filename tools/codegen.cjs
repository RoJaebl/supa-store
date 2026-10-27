// 생성기 핵심 — CLI·Next 래퍼·tsserver 플러그인이 함께 쓴다. 플러그인이 CommonJS 여야 하므로 이 파일도 CommonJS 다
const { createRequire } = require("node:module");
const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { basename, dirname, join, relative, resolve } = require("node:path");

// src/config.ts 의 defaults 와 같다 — dist 는 ESM 이라 여기서 부를 수 없다
const defaults = { include: ["src/**/*.state.ts"], out: "src/store.gen.ts", targets: ["tsserver", "next", "vite", "cli"] };
const CONFIG_FILE = "store.config.ts";
const MAX_ROUNDS = 5;
// 「이름을 찾을 수 없다」 계열 — 2304 Cannot find name · 2552 Did you mean · 2503 Cannot find namespace
const NAME_NOT_FOUND = new Set([2304, 2552, 2503]);

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
  const fnArgs = [];
  // query 의 첫 매개변수 타입의 갈래들(유니온이면 그 갈래 모두) — 읽지 못하면 빈 배열
  const argsTypes = (call) => {
    const fn = call.arguments[0];
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return [];
    const def = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(fn));
    const query = def.getProperty("query");
    const param = query && checker.getTypeOfSymbolAtLocation(query, fn).getCallSignatures()[0]?.parameters[0];
    if (!param) return [];
    const type = checker.getTypeOfSymbolAtLocation(param, fn);
    return type.isUnion() ? type.types : [type];
  };
  // 배열·튜플인가 — 옛 TypeScript 는 두 검사 함수를 내주지 않는다. 읽지 못하면 건너뛴다
  const isArrayType = (t) =>
    typeof checker.isArrayType === "function" && typeof checker.isTupleType === "function" && (checker.isArrayType(t) || checker.isTupleType(t));
  // 함수인가 — 조건 무효화(invalidate(fn))와 헷갈린다
  const isFnType = (t) => t.getCallSignatures().length > 0;
  // 생성 파일에서 풀리지 않을 이름 — 글자로 옮긴 타입에 맨 이름으로 남은 것을 정의 자리(at)의 범위에서 찾아 가른다.
  // 같은 이름의 전역(DOM 의 Response 등)이 있어도 정의 파일의 것을 본다. top 이 false 면 export 로 풀 수 없다
  const userFile = (sf) => !program.isSourceFileDefaultLibrary(sf) && !program.isSourceFileFromExternalLibrary(sf) && !/\/node_modules\//.test(posix(sf.fileName));
  const resolveAlias = (sym) => (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
  const hiddenNames = (typeNode, at) => {
    const bound = new Set();
    const refs = new Set();
    const walk = (n) => {
      if (ts.isTypeParameterDeclaration(n)) bound.add(n.name.text);
      if (ts.isTypeReferenceNode(n)) {
        let q = n.typeName;
        while (ts.isQualifiedName(q)) q = q.left;
        refs.add(q.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(typeNode);
    const scope = new Map();
    for (const sym of checker.getSymbolsInScope(at, ts.SymbolFlags.Type | ts.SymbolFlags.Namespace)) if (!scope.has(sym.name)) scope.set(sym.name, sym);
    const hidden = [];
    for (const name of refs) {
      if (bound.has(name)) continue;
      const found = scope.get(name);
      const sym = found && resolveAlias(found);
      if (!sym || sym.flags & ts.SymbolFlags.TypeParameter) {
        hidden.push({ name, top: false });
        continue;
      }
      const decl = sym.declarations?.[0];
      const sf = decl?.getSourceFile();
      // lib · 패키지 · 전역 스크립트 · declare global 안의 것은 생성 파일에서도 같은 이름으로 풀린다
      if (!sf || !userFile(sf) || !ts.isExternalModule(sf) || ts.findAncestor(decl, (n) => ts.isModuleDeclaration(n) && ts.isGlobalScopeAugmentation(n))) continue;
      if (decl.parent !== sf) {
        hidden.push({ name, top: false });
        continue;
      }
      const mod = checker.getSymbolAtLocation(sf);
      const exported = mod && checker.getExportsOfModule(mod).some((e) => resolveAlias(e).declarations?.includes(decl));
      if (!exported) hidden.push({ name, top: true });
    }
    return hidden;
  };
  for (const source of program.getSourceFiles()) {
    if (!config.match(source.fileName)) continue;
    // 문법이 깨진 정의는 반환 타입이 any 로 무너진다 — 그것을 쓰면 타입 검사가 조용히 꺼지므로 아예 짓지 않는다
    if (program.getSyntacticDiagnostics(source).length) {
      broken.push(posix(source.fileName));
      continue;
    }
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createResource") {
        const types = argsTypes(node);
        if (types.some(isArrayType)) arrayArgs.push(posix(source.fileName));
        if (types.some(isFnType)) fnArgs.push(posix(source.fileName));
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
          // 반환 타입을 적은 정의는 사람이 타입을 정한 것이라 라이브러리 기본 타입 인자의 any 를 허용한다
          entries.push({ file: posix(source.fileName), key: key.text, text, any: !fn.type && hasAny(typeNode), hidden: hiddenNames(typeNode, fn) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (broken.length) throw new Error(`정의 파일의 문법이 깨져 생성 파일을 쓰지 않는다: ${broken.join(", ")}`);
  if (loose.length) throw new Error(`${[...new Set(loose)].map((f) => posix(relative(config.root, f))).join(", ")}: createStore 의 key 는 문자열 그대로 쓴다`);
  if (arrayArgs.length) throw new Error(`${[...new Set(arrayArgs)].map((f) => posix(relative(config.root, f))).join(", ")}: 자원의 args 는 배열로 짓지 않는다 — 여러 값은 객체로 묶는다`);
  if (fnArgs.length) throw new Error(`${[...new Set(fnArgs)].map((f) => posix(relative(config.root, f))).join(", ")}: 자원의 args 는 함수로 짓지 않는다 — 조건 무효화와 헷갈린다`);
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// 상대 경로에 실제 파일을 찾아 그 JS 확장자를 붙인다. 못 찾으면 그대로 둔다
const JS_EXT = [[".ts", ".js"], [".tsx", ".js"], [".d.ts", ".js"], [".mts", ".mjs"], [".d.mts", ".mjs"], [".cts", ".cjs"], [".d.cts", ".cjs"]];
const withJsExt = (spec) => {
  if (/\.[cm]?jsx?$/.test(spec)) return spec;
  const hit = JS_EXT.find(([ts]) => existsSync(spec + ts));
  return hit ? spec + hit[1] : spec;
};

function relativeFromOut(config, file) {
  const rel = posix(relative(dirname(config.out), file));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const bare = (p) => posix(p).replace(/^\.\//, "").replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
const DECL = /\.d\.[cm]?ts$/;

// 패키지 안 .d.ts 하나를 한 번만 읽어 자기 선언 · 이름 있는 재내보내기 · export * 대상을 따로 둔다
// links 는 [내보내는 이름, 대상 파일, 대상에서의 이름], nss 는 export * as 의 [네임스페이스 이름, 대상 파일]
function readExports(ts, pkgDir, file, ctx) {
  const info = { own: new Map(), links: [], stars: [], nss: [], deps: [] };
  ctx.parsed.set(file, info);
  let source;
  try {
    const path = join(pkgDir, file);
    source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    ctx.files.add(path);
  } catch {
    return info;
  }
  // 상대 지정자만 따라간다 — ./x.js 는 ./x.d.ts, ./x 는 ./x.d.ts · ./x/index.d.ts 로 푼다. .cjs · .d.cts 계열은 .d.cts 를, .mjs · .d.mts 계열은 .d.mts 를 먼저 본다
  const resolveRel = (spec) => {
    if (!spec.startsWith(".")) return null;
    const base = posix(join(dirname(file), spec)).replace(/\.[cm]?js$/, "");
    const family = /\.cjs$/.test(spec) || (!/\.m?js$/.test(spec) && /\.d\.cts$/.test(file)) ? ".d.cts" : /\.mjs$/.test(spec) || (!/\.c?js$/.test(spec) && /\.d\.mts$/.test(file)) ? ".d.mts" : ".d.ts";
    const tries = [family, ".d.ts", ".d.mts", ".d.cts", ".ts", "/index.d.ts"].map((ext) => base + ext);
    const hit = tries.find((t) => existsSync(join(pkgDir, t))) ?? null;
    if (hit) info.deps.push(hit);
    return hit;
  };
  const here = bare(file);
  const imported = new Map(); // 지역 이름 → [대상 파일, 대상에서의 이름]
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const target = resolveRel(st.moduleSpecifier.text);
    if (target) for (const el of named.elements) imported.set(el.name.text, [target, (el.propertyName ?? el.name).text]);
  }
  for (const st of source.statements) {
    if (ts.isExportDeclaration(st)) {
      const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? resolveRel(st.moduleSpecifier.text) : undefined;
      if (!st.exportClause) {
        if (target) info.stars.push(target);
      } else if (ts.isNamespaceExport(st.exportClause)) {
        if (target) info.nss.push([st.exportClause.name.text, target]);
      } else if (ts.isNamedExports(st.exportClause)) {
        // export { ns } from "./x" · import * as ns 뒤의 export { ns } 는 ns 길로 따라가지 않는다 — 그 이름을 쓰면 「내보내는 패키지 진입이 없다」로 시끄럽게 멈춘다
        for (const el of st.exportClause.elements) {
          const from = (el.propertyName ?? el.name).text;
          const via = st.moduleSpecifier ? (target ? [target, from] : null) : imported.get(from);
          if (via) info.links.push([el.name.text, ...via]);
          else if (!st.moduleSpecifier) info.own.set(el.name.text, { file: here, name: from });
        }
      }
      continue;
    }
    const exported = ts.canHaveModifiers?.(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    const decls = ts.isVariableStatement(st) ? st.declarationList.declarations : [st];
    for (const d of decls) if (d.name && ts.isIdentifier(d.name)) info.own.set(d.name.text, { file: here, name: d.name.text });
  }
  return info;
}

// 진입들에서 닿는 파일을 모두 읽은 뒤 이름 표를 바뀌지 않을 때까지 되풀이해 채운다 — 순환 · 다이아몬드도 파일마다 한 번만 읽는다
// 파일 → (내보내는 이름 → { file: 패키지 안 경로(확장자 없음), name: 원래 이름 })
const MAX_NS_DOTS = 3;
const dots = (name) => name.split(".").length - 1;
function exportTables(ts, pkgDir, entries, ctx) {
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!ctx.parsed.has(file)) queue.push(...readExports(ts, pkgDir, file, ctx).deps);
  }
  let tables = new Map([...ctx.parsed.keys()].map((f) => [f, new Map()]));
  // 순환에서는 이름이 들어오는 순서가 매 회 달라지므로 순서 없이 견준다
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.file === v.file && b.get(k)?.name === v.name);
  // 이름의 집합은 늘기만 하고 값은 대상의 값을 따라가므로 멈춘다 — 그래도 끝없이 돌지 않게 파일 수만큼으로 막는다
  for (let round = 0; round <= ctx.parsed.size + 1; round++) {
    let changed = false;
    const next = new Map();
    for (const [file, info] of ctx.parsed) {
      const names = new Map(info.own);
      for (const [as, target, from] of info.links) names.set(as, tables.get(target)?.get(from) ?? { file: bare(target), name: from });
      // export * 는 이름 있는 내보내기를 덮지 않는다
      for (const target of info.stars) for (const [k, v] of tables.get(target) ?? []) if (!names.has(k)) names.set(k, v);
      // export * as ns 는 대상의 이름을 「ns.이름」으로 싣는다 — ns 순환의 갈래가 열쇠를 거듭제곱으로 불리므로 점 셋(ns 사슬 3단)까지만 싣는다
      for (const [ns, target] of info.nss)
        for (const [k, v] of tables.get(target) ?? []) if (dots(k) < MAX_NS_DOTS) names.set(`${ns}.${k}`, v);
      if (!same(names, tables.get(file))) changed = true;
      next.set(file, names);
    }
    tables = next;
    if (!changed) break;
  }
  return tables;
}

// 패키지마다 진입 분석을 한 번만 짓는다 — package.json 이나 읽은 .d.ts 가 바뀌면(재설치 · link 한 패키지의 재빌드) 다시 짓는다
const packageCache = new Map();
const stampOf = (files) =>
  [...files]
    .map((f) => {
      try {
        return statSync(f).mtimeMs;
      } catch {
        return -1;
      }
    })
    .join(",");
function packageEntries(ts, pkgDir) {
  const pkgJson = join(pkgDir, "package.json");
  const hit = packageCache.get(pkgDir);
  if (hit && hit.stamp === stampOf(hit.files)) return hit.value;
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  } catch {}
  const ctx = { parsed: new Map(), files: new Set([pkgJson]) };
  const value = { pkg, routes: [], excluded: [] };
  if (pkg.exports) {
    const exp = pkg.exports;
    const map = typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith(".")) ? exp : { ".": exp };
    // 조건이 겹친 대상(import.types 같은 것)과 배열까지 끝의 글자를 모두 모은다
    const targets = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(targets) : []);
    for (const [sub, v] of Object.entries(map)) {
      const subpath = sub.replace(/^\.\/?/, "");
      if (v === null) {
        value.excluded.push(subpath);
        continue;
      }
      for (const target of targets(v)) {
        if (target.includes("*")) value.routes.push({ subpath, star: bare(target).split("*") });
        else if (DECL.test(target)) {
          const file = posix(target).replace(/^\.\//, "");
          value.routes.push({ subpath, file, entry: bare(file) });
        }
      }
    }
    const tables = exportTables(ts, pkgDir, value.routes.filter((r) => r.file).map((r) => r.file), ctx);
    for (const r of value.routes) if (r.file) r.names = tables.get(r.file);
  }
  packageCache.set(pkgDir, { files: ctx.files, stamp: stampOf(ctx.files), value });
  return value;
}

const starMatch = (pattern, s) => {
  const [head, tail] = pattern.split("*");
  if (tail === undefined) return pattern === s ? "" : null;
  return s.startsWith(head) && s.endsWith(tail) && s.length >= head.length + tail.length ? s.slice(head.length, s.length - tail.length) : null;
};

// node_modules/<패키지>/… 에 선언된 이름을 그 이름을 내보내는 진입의 「지정자 + 이름」으로 바꾼다. 패키지 밖이면 null
function packageImport(ts, config, spec, name) {
  // 프로젝트 안 파일은 프로젝트가 어느 node_modules 아래 있어도 상대 경로로 둔다
  const same = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const root = same(`${config.root}/`);
  if (same(spec).startsWith(root) && !same(spec).startsWith(`${root}node_modules/`)) return null;
  // 마지막 node_modules 가 패키지 자리다 — pnpm 의 .pnpm/<이름>@<판>/node_modules/<이름> 도 이것으로 풀린다
  const m = /^(.*\/node_modules\/)((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(spec);
  if (!m) return null;
  const [, base, dir, rest] = m;
  // @types/foo 는 foo, @types/scope__pkg 는 @scope/pkg 로 쓴다
  const pkgName = dir.startsWith("@types/") ? dir.slice(7).replace(/^(.+)__/, "@$1/") : dir;
  const file = bare(rest);
  const { pkg, routes, excluded } = packageEntries(ts, `${base}${dir}`);
  const at = (sub) => (sub ? `${pkgName}/${sub}` : pkgName);
  if (!pkg.exports) {
    // exports 가 없으면 깊은 경로가 그대로 풀린다 — 진입 파일이면 이름만 쓴다
    const entry = bare(pkg.types ?? pkg.typings ?? pkg.main ?? "index");
    return { spec: file === entry || file === "index" ? pkgName : `${pkgName}/${file}`, name };
  }
  const open = (sub) => !excluded.some((x) => starMatch(x, sub) !== null);
  // 네임스페이스 길(ns.이름)은 이름 붙은 길이 어디에도 없을 때만 쓰고, 그 가운데 점이 가장 적은 것을 고른다(순환이면 깊은 길이 먼저 온다)
  let viaNs;
  for (const r of routes) {
    if (r.star) {
      // 별 패턴은 파일 자체가 진입이다
      const cut = starMatch(r.star.join("*"), file);
      const sub = cut === null ? null : r.subpath.replace("*", cut);
      if (sub !== null && open(sub)) return { spec: at(sub), name };
      continue;
    }
    if (!open(r.subpath)) continue;
    // 진입 파일 자신에 선언된 것(export = 의 네임스페이스 · default 포함)은 그 진입에서 그대로 닿는다
    if (r.entry === file) return { spec: at(r.subpath), name };
    if (!name) continue;
    for (const [as, o] of r.names) {
      if (o.file !== file || o.name !== name) continue;
      if (!as.includes(".")) return { spec: at(r.subpath), name: as };
      if (!viaNs || dots(as) < dots(viaNs.name)) viaNs = { spec: at(r.subpath), name: as };
    }
  }
  return viaNs;
}

// 생성 파일이 Node16 · NodeNext 의 ESM 이면 상대 경로에 확장자가 있어야 한다
function esmOut(ts, program, config) {
  const out = posix(config.out).toLowerCase();
  const sf = program.getSourceFiles().find((f) => posix(f.fileName).toLowerCase() === out);
  const options = program.getCompilerOptions();
  const kind = ts.getEmitModuleResolutionKind?.(options) ?? options.moduleResolution;
  return !!sf && sf.impliedNodeFormat === ts.ModuleKind.ESNext && (kind === ts.ModuleResolutionKind.Node16 || kind === ts.ModuleResolutionKind.NodeNext);
}

function render(entries, config, ts, esm = false) {
  const files = [...new Set(entries.map((e) => e.file))];
  const types = entries.map((e) => {
    // NodeNext 는 둘째 인자(import("…", { with: { "resolution-mode": "import" } }))를 붙인다 — 경로만 바꾸고 그것은 그대로 둔다
    const text = e.text.replace(/import\("([^"]+)"(,\s*\{[^()]*\})?\)(\.([A-Za-z_$][\w$]*))?/g, (whole, spec, attrs = "", dot, name) => {
      if (!/^(?:[A-Za-z]:)?\//.test(spec)) return whole;
      const hit = packageImport((ts ??= requireTypeScript(config.root)), config, spec, name);
      if (hit === null) return `import("${relativeFromOut(config, esm ? withJsExt(spec) : spec)}"${attrs})${dot ?? ""}`;
      if (hit === undefined) throw new Error(`${e.key}(${e.file}): ${name ?? "(이름 없음)"} 을 내보내는 패키지 진입이 없다(export * as 사슬은 3단까지 따라간다) — ${spec}`);
      return `import("${hit.spec}"${attrs})${hit.name ? `.${hit.name}` : ""}`;
    });
    return `    ${JSON.stringify(e.key)}: ${text};`;
  });
  return [
    "// 자동 생성 — supa-store 가 쓴다. 고치지 않는다",
    "export {};",
    ...files.map((f) => `import "${esm ? relativeFromOut(config, f).replace(/\.([cm]?)tsx?$/, ".$1js") : relativeFromOut(config, f).replace(/\.ts$/, "")}";`),
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

// 생성 파일에서 쓸 수 없는 이름을 key 마다 모아 문구로 돌려준다. 없으면 null.
// collect 가 정의 자리에서 가른 이름(hidden)이 먼저이고, 생성 파일의 「이름을 찾을 수 없다」 진단이 그 밖의 것을 보탠다
function unexported(ts, program, config, entries) {
  const byKey = new Map(entries.map((e) => [e, { top: new Set(), local: new Set() }]));
  for (const e of entries) for (const h of e.hidden ?? []) byKey.get(e)[h.top ? "top" : "local"].add(h.name);
  const out = posix(config.out).toLowerCase();
  const gen = program.getSourceFiles().find((f) => posix(f.fileName).toLowerCase() === out);
  for (const d of gen ? program.getSemanticDiagnostics(gen) : []) {
    if (!NAME_NOT_FOUND.has(d.code) || d.start === undefined) continue;
    const text = gen.text;
    const line = text.slice(text.lastIndexOf("\n", d.start) + 1, text.indexOf("\n", d.start));
    const entry = entries.find((e) => line.startsWith(`    ${JSON.stringify(e.key)}: `));
    const name = text.slice(d.start, d.start + d.length);
    if (entry && !byKey.get(entry).local.has(name)) byKey.get(entry).top.add(name);
  }
  const lines = [];
  for (const [e, { top, local }] of byKey) {
    const at = `${e.key}(${posix(relative(config.root, e.file))})`;
    if (top.size) {
      const list = [...top].join(", ");
      lines.push(`${at}: 상태 필드의 타입 ${list} 이 export 되지 않아 생성 파일에서 쓸 수 없다 — ${list} 을 export 한다`);
    }
    if (local.size) lines.push(`${at}: 상태 필드의 타입 ${[...local].join(", ")} 은 최상위에서 export 할 수 있는 타입이 아니다 — 반환 타입을 적거나 최상위 타입으로 옮긴다`);
  }
  return lines.length ? lines.join("\n") : null;
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
    const next = render(entries, config, ts, esmOut(ts, program, config));
    if (next === text) {
      const hidden = unexported(ts, program, config, entries);
      if (hidden) throw new Error(hidden);
      const bad = entries.find((e) => e.any);
      // 고정점에도 any 가 남으면 그 key 의 타입 검사가 조용히 꺼진다 — 쓰지 않고 반환 타입을 적게 한다
      if (bad) throw new Error(`${bad.key}(${posix(relative(config.root, bad.file))}) 의 타입에 any 가 남는다 — 반환 타입을 적는다`);
      return writeIfChanged(config.out, text);
    }
    text = next;
  }
  throw new Error(`생성 결과가 ${MAX_ROUNDS} 번 돌아도 멈추지 않는다 — 정의의 반환 타입을 적는다`);
}

module.exports = { loadConfig, collect, render, generate, writeIfChanged, requireTypeScript, esmOut, unexported };
