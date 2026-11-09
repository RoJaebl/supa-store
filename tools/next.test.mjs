import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { withStore } from "./next.mjs";

const decline = createRequire(import.meta.url)("./decline-loader.cjs");
const DEV = "phase-development-server";
const DEFINITION = `import { createStore } from "supa-store";\nexport const s = createStore(() => ({}));`;

test("loader 는 정의 파일 끝에 decline 을 덧붙이고 그 밖은 그대로 둔다", () => {
  assert.match(decline(DEFINITION), /import\.meta\.webpackHot\.decline\(\)/);
  assert.ok(decline(DEFINITION).startsWith(DEFINITION));
  const plain = `export const a = 1;`;
  assert.equal(decline(plain), plain);
});

test("개발 모드의 브라우저 webpack 설정에만 loader 규칙이 선다", () => {
  const webpack = withStore({})(DEV).webpack;
  const rulesOf = (opts) => webpack({ module: { rules: [] } }, opts).module.rules;
  const rules = rulesOf({ dev: true, isServer: false });
  assert.equal(rules.length, 1);
  assert.match(rules[0].loader, /decline-loader\.cjs$/);
  assert.ok(rules[0].exclude.test("/a/node_modules/b.js"));
  assert.equal(rulesOf({ dev: false, isServer: false }).length, 0);
  assert.equal(rulesOf({ dev: true, isServer: true }).length, 0);
});

test("사용자의 webpack 함수를 먼저 부른다", () => {
  const user = (config) => ({ ...config, module: { rules: [{ marker: true }] } });
  const out = withStore({ webpack: user })(DEV).webpack({}, { dev: true, isServer: false });
  assert.equal(out.module.rules[0].marker, true);
  assert.match(out.module.rules[1].loader, /decline-loader\.cjs$/);
});

test("개발 서버가 아닌 단계에서는 nextConfig 를 그대로 돌려준다", () => {
  const config = { typedRoutes: true };
  assert.equal(withStore(config)("phase-production-build"), config);
});

const hasRule = (config) =>
  config.webpack({ module: { rules: [] } }, { dev: true, isServer: false }).module.rules.length === 1;

test("함수형 nextConfig 는 호출한 결과에 같은 감싸기를 건다", () => {
  const seen = [];
  const fn = (phase, ctx) => (seen.push([phase, ctx]), { typedRoutes: true });
  const out = withStore(fn)(DEV, "ctx");
  assert.deepEqual(seen, [[DEV, "ctx"]]);
  assert.equal(out.typedRoutes, true);
  assert.ok(hasRule(out));
});

test("비동기 함수형 nextConfig 도 풀어서 감싼다", async () => {
  const out = await withStore(async () => ({ typedRoutes: true }))(DEV, {});
  assert.equal(out.typedRoutes, true);
  assert.ok(hasRule(out));
});

test("함수형 nextConfig 는 개발 서버가 아닌 단계에서 결과를 그대로 돌려준다", () => {
  const config = { typedRoutes: true };
  assert.equal(withStore(() => config)("phase-production-build", {}), config);
});

test("loader 규칙의 exclude 는 두 경로 구분자의 node_modules 를 빼고 소스는 빼지 않는다", () => {
  const [rule] = withStore({})(DEV).webpack({ module: { rules: [] } }, { dev: true, isServer: false }).module.rules;
  assert.ok(rule.exclude.test("C:\\a\\node_modules\\b.js"));
  assert.ok(rule.exclude.test("/a/node_modules/b.js"));
  assert.ok(!rule.exclude.test("/a/src/b.ts"));
});
