// supaStore — Vite 가 시작할 때 생성 파일을 쓰고, 개발 서버에서는 정의 파일을 감시해 다시 쓴다
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const { loadConfig, generate, requireTypeScript } = require("./codegen.cjs");

// 개발 서버의 생성은 worker 에서 돈다 — 같은 스레드에서 돌면 생성하는 몇 초 동안 프록시 · HMR 이 멈춘다.
// 도는 중에 다시 부르면 끝난 뒤 한 번만 더 돈다. 돌려준 Promise 는 더 돌 것이 없을 때 풀린다
function startWorker(root, logger) {
  const worker = new Worker(new URL("./codegen-worker.cjs", import.meta.url), { workerData: { root } });
  worker.unref(); // 개발 서버를 닫지 않고 끝나는 프로세스를 붙잡지 않게
  let busy = false;
  let again = false;
  const waiting = [];
  const kick = () => {
    busy = true;
    again = false;
    worker.postMessage(null);
  };
  const idle = () => {
    busy = false;
    waiting.splice(0).forEach((resolve) => resolve());
  };
  worker.on("message", ({ error }) => {
    if (error) logger.error(error); // 서버는 살린다 — 고치면 다음 변경에 다시 쓴다
    if (again) kick();
    else idle();
  });
  worker.on("error", (error) => {
    logger.error(error.message);
    idle();
  });
  return {
    run() {
      if (busy) again = true;
      else kick();
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => worker.terminate(),
  };
}

export function supaStore() {
  let ts, config, serve, logger, root, worker;
  return {
    name: "supa-store",
    configResolved(resolved) {
      serve = resolved.command === "serve";
      logger = resolved.logger;
      root = resolved.root;
      ts = requireTypeScript(root);
      config = loadConfig(ts, root);
    },
    async buildStart() {
      if (!config.enabled("vite")) return;
      // 개발 서버는 worker 로 쓴다 — 첫 생성이 worker 의 소스 파일을 데워 둔다. 실패해도 서버는 살린다
      if (worker) return worker.run();
      generate(ts, config); // 빌드는 실패하면 멈춘다
    },
    configureServer(server) {
      if (!config.enabled("vite") || !serve) return;
      worker = startWorker(root, logger);
      let timer;
      const again = () => {
        clearTimeout(timer);
        timer = setTimeout(() => worker.run(), 200);
        timer.unref();
      };
      for (const event of ["add", "unlink", "change"]) {
        server.watcher.on(event, (file) => config.match(file) && again());
      }
    },
    async closeBundle() {
      await worker?.close();
      worker = undefined;
    },
  };
}
