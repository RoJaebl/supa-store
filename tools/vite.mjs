// supaStore — Vite 가 시작할 때 생성 파일을 쓰고, 개발 서버에서는 정의 파일을 감시해 다시 쓴다
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig, generate, requireTypeScript } = require("./codegen.cjs");

export function supaStore() {
  let ts, config;
  return {
    name: "supa-store",
    configResolved(resolved) {
      ts = requireTypeScript(resolved.root);
      config = loadConfig(ts, resolved.root);
    },
    buildStart() {
      if (config.enabled("vite")) generate(ts, config); // 실패하면 던진다 — 빌드를 멈춘다
    },
    configureServer(server) {
      if (!config.enabled("vite")) return;
      let timer;
      const again = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            generate(ts, config);
          } catch (error) {
            server.config.logger.error(error.message); // 서버는 살린다 — 고치면 다음 변경에 다시 쓴다
          }
        }, 200);
        timer.unref();
      };
      for (const event of ["add", "unlink", "change"]) {
        server.watcher.on(event, (file) => config.match(file) && again());
      }
    },
  };
}
