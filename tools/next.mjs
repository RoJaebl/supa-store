// withStore — 개발 모드에서 정의 파일이 HMR 갱신을 받지 않게 한다(spec §3.6).
// 정의를 고치면(또는 그것이 기대는 모듈을 고치면) webpack 이 받지 않는 모듈에서 멈추고 전체를 다시 읽는다
import { fileURLToPath } from "node:url";

const LOADER = fileURLToPath(new URL("./decline-loader.cjs", import.meta.url));

function wrap(nextConfig) {
  return {
    ...nextConfig,
    webpack(config, options) {
      const base = nextConfig?.webpack ? nextConfig.webpack(config, options) : config;
      if (!options.dev || options.isServer) return base;
      base.module ??= {};
      base.module.rules = [
        ...(base.module.rules ?? []),
        { test: /\.[cm]?[jt]sx?$/, exclude: /[\/]node_modules[\/]/, loader: LOADER },
      ];
      return base;
    },
  };
}

export function withStore(nextConfig) {
  return (phase, ctx) => {
    // 함수형 설정은 먼저 불러 결과(Promise 일 수 있다)에 같은 감싸기를 건다
    const resolved = typeof nextConfig === "function" ? nextConfig(phase, ctx) : nextConfig;
    if (phase !== "phase-development-server") return resolved;
    return typeof resolved?.then === "function" ? resolved.then(wrap) : wrap(resolved);
  };
}
