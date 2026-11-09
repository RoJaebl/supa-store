import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { isDefinition } = createRequire(import.meta.url)("./definition.cjs");

test("createStore 를 가져오면 정의다", () => {
  assert.equal(isDefinition(`import { createStore } from "supa-store";`), true);
  assert.equal(isDefinition(`import { USE, createStore as cs } from 'supa-store'`), true);
  assert.equal(isDefinition(`import {\n  createStore,\n} from "supa-store"`), true);
  assert.equal(isDefinition(`import * as s from "supa-store";\nexport const x = s.createStore(() => ({}));`), true);
});
test("범위 이름으로 가져와도 정의다", () => {
  assert.equal(isDefinition(`import { createStore } from "@rojaebl/supa-store";`), true);
  assert.equal(isDefinition(`import * as s from '@rojaebl/supa-store'`), true);
  assert.equal(isDefinition(`import { useStore } from "@rojaebl/supa-store/react";`), false);
  assert.equal(isDefinition(`import { createStore } from "other/supa-store";`), false);
});
test("그 밖은 정의가 아니다", () => {
  assert.equal(isDefinition(`import { useStore } from "supa-store/react";`), false);
  assert.equal(isDefinition(`import { getStore } from "supa-store";`), false);
  assert.equal(isDefinition(`import * as r from "supa-store/react";`), false);
  assert.equal(isDefinition(`// createStore 는 supa-store 에서\nexport const x = 1`), false);
});

test("createStore.ofContext 만 쓰는 파일도 정의다", () => {
  assert.equal(isDefinition(`import { createStore } from "supa-store";\nexport const x = createStore.ofContext((ctx) => ({}));`), true);
  assert.equal(isDefinition(`import { createStore as cs } from "supa-store";\nexport const x = cs.ofContext((ctx) => ({}));`), true);
});
