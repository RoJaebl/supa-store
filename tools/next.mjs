// withStore — Next 가 설정을 읽을 때 생성 파일을 쓰고, dev 서버에서는 정의 파일을 감시해 다시 쓴다
import { watch } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig, generate, requireTypeScript } = require("./codegen.cjs");

// Next 는 설정을 여러 번 읽으므로 감시는 프로세스에 한 번만 건다
const WATCHING = Symbol.for("@fortuna-lottery/store/watching");

export function withStore(nextConfig) {
  return (phase) => {
    const ts = requireTypeScript(process.cwd());
    const config = loadConfig(ts, process.cwd());
    if (!config.enabled("next")) return nextConfig;
    generate(ts, config);
    if (phase === "phase-development-server" && !globalThis[WATCHING]) {
      globalThis[WATCHING] = true;
      const src = `${config.root}/src`;
      let timer;
      const regenerate = () => {
        try {
          generate(ts, config);
        } catch (error) {
          console.error(error.message); // dev 서버를 죽이지 않는다 — 고치면 다음 변경에 다시 쓴다
        }
      };
      watch(src, { recursive: true }, (_event, file) => {
        if (!file || !config.match(`${src}/${file}`)) return;
        clearTimeout(timer);
        timer = setTimeout(regenerate, 200);
        timer.unref();
      }).unref();
    }
    return nextConfig;
  };
}
