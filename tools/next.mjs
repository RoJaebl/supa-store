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
      const src = `${config.root}/src`;
      let timer;
      const regenerate = () => {
        try {
          generate(ts, config);
        } catch (error) {
          console.error(error.message); // dev 서버를 죽이지 않는다 — 고치면 다음 변경에 다시 쓴다
        }
      };
      try {
        watch(src, { recursive: true }, (_event, file) => {
          if (!file || !config.match(`${src}/${file}`)) return;
          clearTimeout(timer);
          timer = setTimeout(regenerate, 200);
          timer.unref();
        })
          .on("error", (error) => console.error(`store-gen: 감시가 멈췄다 — ${error.message}`))
          .unref();
        globalThis[WATCHING] = true; // 감시가 선 뒤에만 표시한다 — 실패하면 다음에 설정을 읽을 때 다시 건다
      } catch (error) {
        console.error(`store-gen: 정의 파일을 감시하지 못했다 — ${error.message}`);
      }
    }
    return nextConfig;
  };
}
