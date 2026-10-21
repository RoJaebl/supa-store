#!/usr/bin/env node
// store-gen — 현재 폴더의 프로젝트에서 생성 파일을 쓴다. targets 에 cli 가 없으면 건너뛴다
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig, generate, requireTypeScript } = require("./codegen.cjs");

try {
  const ts = requireTypeScript(process.cwd());
  const config = loadConfig(ts, process.cwd());
  if (config.enabled("cli")) generate(ts, config);
  else console.log("store-gen: targets 에 cli 가 없어 건너뛴다");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
