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
      // tsserver 는 디스크에 없는 파일의 문서를 지으면 Debug Failure 로 죽는다 — 없으면 빈 생성 파일을 먼저 쓴다
      if (!existsSync(config.out)) writeIfChanged(config.out, render([], config));
      let text = readFileSync(config.out, "utf8");
      let version = 0;
      let building = false;

      // 이 프로그램으로 생성 내용을 짓는다. 바뀌었으면 판본을 올리고 디스크에 쓰고 true 를 돌려준다.
      // collect 가 던지면(정의 파일의 문법이 깨졌을 때 등) 앞의 내용을 그대로 두고 디스크에도 쓰지 않는다
      const refresh = (program) => {
        if (!program) return false;
        try {
          const next = render(collect(ts, program, config), config);
          writeIfChanged(config.out, next);
          if (next === text) return false;
          text = next;
          version++;
          return true;
        } catch (error) {
          log(error.message);
          return false;
        }
      };

      // 실제 tsserver: 프로그램을 다시 지은 직후 그 프로그램으로 생성 내용을 짓는다. 바뀌었으면 같은 요청 안에서
      // 한 번 더 지어 따라잡는다 — tsserver 는 프로젝트가 dirty 할 때만 판본을 물으므로, 미루면 다음 편집까지 낡은 타입이 남는다
      const project = info.project;
      const inTsserver = ["updateGraph", "getCurrentProgram", "markAsDirty"].every((m) => typeof project[m] === "function");
      if (inTsserver) {
        const updateGraph = project.updateGraph.bind(project);
        project.updateGraph = (...args) => {
          let result = updateGraph(...args);
          for (let round = 0; round < 2 && refresh(project.getCurrentProgram()); round++) {
            project.markAsDirty();
            result = updateGraph(...args);
          }
          return result;
        };
      }

      // 맨 LanguageService(updateGraph 가 없다): 판본을 물을 때 직전 프로그램으로 짓는다 — 한 번만큼 늦을 수 있다.
      // 짓는 동안 다시 들어오면(getProgram 이 이 파일을 다시 묻는다) 앞의 내용을 준다
      const build = () => {
        if (inTsserver || building) return;
        building = true;
        try {
          refresh(info.languageService.getProgram());
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
      return info.languageService;
    },
  };
};
