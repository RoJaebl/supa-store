// supaStore — 개발 서버에서 정의 파일이 다시 돌 갱신이면 Fast Refresh 대신 페이지 전체를 다시 읽게 한다.
// 정의 모듈이 다시 돌면 새 store 가 생기고 옛 store 와 그 듣기는 버려지지 않은 채 남기 때문이다
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { isDefinition } = createRequire(import.meta.url)("./definition.cjs");

export function supaStore() {
  let off = false;
  return {
    name: "supa-store",
    apply: "serve",
    configResolved() {
      off = !!process.env.VITEST;
    },
    hotUpdate({ modules }) {
      if (off || this.environment.name !== "client") return;
      // 바뀐 모듈에서 import 한 쪽으로 거슬러 넓이 우선으로 돈다 — 그 길의 모듈은 모두 다시 실행된다
      const seen = new Set(modules);
      const queue = [...modules];
      const read = new Set(); // 한 번의 갱신 안에서 같은 파일을 두 번 읽지 않는다
      for (let i = 0; i < queue.length; i++) {
        const { file, importers } = queue[i];
        if (file && !read.has(file)) {
          read.add(file);
          let code = "";
          try {
            code = readFileSync(file, "utf8");
          } catch {} // 지워진 파일은 정의가 아니다
          if (isDefinition(code)) {
            this.environment.hot.send({ type: "full-reload" });
            return [];
          }
        }
        for (const importer of importers) {
          if (seen.has(importer)) continue;
          seen.add(importer);
          queue.push(importer);
        }
      }
    },
  };
}
