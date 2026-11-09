// withStore — 개발 모드에서 정의 파일이 HMR 갱신을 받지 않게 한다(spec §3.6).
// 정의를 고치면(또는 그것이 기대는 모듈을 고치면) webpack 이 받지 않는 모듈에서 멈추고 전체를 다시 읽는다
import { fileURLToPath } from "node:url";

const LOADER = fileURLToPath(new URL("./decline-loader.cjs", import.meta.url));

export function withStore(nextConfig) {
  return (phase) => {
    // 함수형 설정은 0.6 처럼 그대로 돌려준다 — 감싸려면 호출 결과(Promise 포함)를 풀어야 한다
    if (phase !== "phase-development-server" || typeof nextConfig === "function") return nextConfig;
    return {
      ...nextConfig,
      webpack(config, options) {
        const base = nextConfig?.webpack ? nextConfig.webpack(config, options) : config;
        if (!options.dev || options.isServer) return base;
        base.module ??= {};
        base.module.rules = [
          ...(base.module.rules ?? []),
          { test: /\.[cm]?[jt]sx?$/, exclude: /[\\/]node_modules[\\/]/, loader: LOADER },
        ];
        return base;
      },
    };
  };
}
