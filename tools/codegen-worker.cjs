// 개발 서버의 생성 worker — 생성(TypeScript 프로그램 짓기)이 Vite 의 스레드를 막지 않게 따로 돈다.
// 읽은 소스 파일을 쥐고 있어 두 번째 생성부터는 바뀐 파일만 다시 파싱한다
const { parentPort, workerData } = require("node:worker_threads");
const { loadConfig, generate, requireTypeScript } = require("./codegen.cjs");

const ts = requireTypeScript(workerData.root);
const config = loadConfig(ts, workerData.root);
const sources = new Map();

parentPort.on("message", () => {
  try {
    generate(ts, config, sources);
    parentPort.postMessage({ error: null });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
