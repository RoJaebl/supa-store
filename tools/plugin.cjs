// tsserver 플러그인 — 편집 중에 생성 파일의 내용을 지어 언어 서비스에 대 주고, 바뀌면 디스크에도 쓴다
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const { loadConfig, collect, render, writeIfChanged } = require("./codegen.cjs");

const same = (p) => p.replace(/\\/g, "/").toLowerCase();

// tsconfig 를 다시 실으면 tsserver 가 create() 를 다시 부른다 — 우리가 앞서 씌운 감싸기를 벗겨 낸 원본을 다시 감싼다.
// 그래야 층이 쌓이지 않고 낡은 config 를 쥔 층이 남지 않는다. 다른 플러그인이 씌운 감싸기는 그대로 둔다
const OURS = Symbol.for("@fortuna-lottery/store/original");
const unwrapped = (fn) => (fn && fn[OURS]) || fn;
const mark = (wrapper, original) => Object.assign(wrapper, { [OURS]: original });

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
      // tsserver 는 디스크에 없는 파일의 문서를 지으면 Debug Failure 로 죽는다 — 없으면 빈 생성 파일을 먼저 쓴다.
      // 그 틈에 다른 생성기(store-gen·withStore)가 쓴 파일은 덮지 않는다(wx)
      try {
        mkdirSync(dirname(config.out), { recursive: true });
        writeFileSync(config.out, render([], config), { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") log(error.message);
      }
      let text = existsSync(config.out) ? readFileSync(config.out, "utf8") : render([], config);
      let version = 0;
      let building = false;

      // 이 프로그램으로 생성 내용을 짓는다. 바뀌었으면 판본을 올리고 디스크에 쓰고 true 를 돌려준다.
      // collect 가 던지면(정의 파일의 문법이 깨졌을 때 등) 앞의 내용을 그대로 두고 디스크에도 쓰지 않는다
      const refresh = (program) => {
        if (!program) return false;
        let next;
        try {
          next = render(collect(ts, program, config), config);
        } catch (error) {
          log(error.message);
          return false;
        }
        // 디스크에 쓰지 못해도(OneDrive 잠금 등) 편집기의 타입은 따라간다
        try {
          writeIfChanged(config.out, next);
        } catch (error) {
          log(error.message);
        }
        if (next === text) return false;
        text = next;
        version++;
        return true;
      };

      // 실제 tsserver: 프로그램을 다시 지은 직후 그 프로그램으로 생성 내용을 짓는다. 바뀌었으면 같은 요청 안에서
      // 한 번 더 지어 따라잡는다 — tsserver 는 프로젝트가 dirty 할 때만 판본을 물으므로, 미루면 다음 편집까지 낡은 타입이 남는다
      const project = info.project;
      const inTsserver = ["updateGraph", "getCurrentProgram", "markAsDirty"].every((m) => typeof project[m] === "function");
      if (inTsserver) {
        const original = unwrapped(project.updateGraph);
        const updateGraph = original.bind(project);
        // updateGraph 는 「파일 집합이 그대로인가」를 돌려준다 — 다시 지은 호출까지 모두 그대로일 때만 true 다
        project.updateGraph = mark((...args) => {
          let result = updateGraph(...args);
          for (let round = 0; round < 2 && refresh(project.getCurrentProgram()); round++) {
            project.markAsDirty();
            result = updateGraph(...args) && result;
          }
          return result;
        }, original);
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
        const original = unwrapped(host[name]);
        if (!original) return;
        const call = original.bind(host);
        host[name] = mark((file, ...rest) => (isOut(file) ? ours() : call(file, ...rest)), original);
      };
      wrap("getScriptVersion", () => (build(), `store-gen-${version}`));
      wrap("getScriptSnapshot", () => (build(), ts.ScriptSnapshot.fromString(text)));
      return info.languageService;
    },
  };
};
