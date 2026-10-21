export type StoreTarget = "tsserver" | "next" | "cli";

export interface StoreConfig {
  /** 정의 파일을 고르는 glob — config 파일 기준. * 는 경로 마디 하나, ** 는 마디 여럿. 기본값 ["src/**\/*.state.ts"] */
  include?: string[];
  /** 생성 파일 자리 — config 파일 기준. 기본값 "src/store.gen.ts" */
  out?: string;
  /** 생성을 맡는 자리. 기본값 ["tsserver"] */
  targets?: StoreTarget[];
}

export const defaults = { include: ["src/**/*.state.ts"], out: "src/store.gen.ts", targets: ["tsserver"] };

export function defineConfig(config: StoreConfig): StoreConfig {
  return config;
}
