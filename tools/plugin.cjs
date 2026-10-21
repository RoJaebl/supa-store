// tsserver 플러그인 — 편집 중에 생성 파일의 내용을 지어 언어 서비스에 대 주고, 바뀌면 디스크에도 쓴다
const { existsSync, readFileSync } = require("node:fs");
const { loadConfig, collect, render, writeIfChanged } = require("./codegen.cjs");

const same = (p) => p.replace(/\\/g, "/").toLowerCase();

module.exports = function init({ typescript: ts }) {
  return {
    create(info) {
      const log = (message) => info.project.projectService.logger.info(`[@fortuna-lottery/store] ${message}`);
      let config;
      try {
        config = loadConfig(ts, info.project.getCurrentDirectory());
      } catch (error) {
        log(error.message);
        return info.languageService;
      }
      if (!config.enabled("tsserver")) return info.languageService;

      const out = same(config.out);
      const isOut = (file) => same(file) === out;
      let text = existsSync(config.out) ? readFileSync(config.out, "utf8") : "";
      let version = 0;
      let building = false;

      // collect 가 던지면(정의 파일의 문법이 깨졌을 때 등) 앞의 내용을 그대로 두고 디스크에도 쓰지 않는다
      // 짓는 동안 다시 들어오면(getProgram 이 이 파일을 다시 묻는다) 앞의 내용을 준다 — 그래서 한 번만큼 늦을 수 있다
      const build = () => {
        if (building) return;
        building = true;
        try {
          const program = info.languageService.getProgram();
          if (!program) return;
          const next = render(collect(ts, program, config), config);
          if (next !== text) {
            text = next;
            version++;
          }
          writeIfChanged(config.out, text);
        } catch (error) {
          log(error.message);
        } finally {
          building = false;
        }
      };

      const host = info.languageServiceHost;
      const wrap = (name, ours) => {
        const original = host[name] && host[name].bind(host);
        if (original) host[name] = (file, ...rest) => (isOut(file) ? ours() : original(file, ...rest));
      };
      wrap("getScriptVersion", () => (build(), `store-gen-${version}`));
      wrap("getScriptSnapshot", () => (build(), ts.ScriptSnapshot.fromString(text)));
      // 아직 디스크에 없어도 import "./store.gen" 이 풀리도록 있다고 답한다
      wrap("fileExists", () => true);
      return info.languageService;
    },
  };
};
