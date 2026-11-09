import { it, expect } from "vitest";
import { labelFromStack } from "./label.js";

const at = (lib: string, caller: string) => `Error\n    at createStore (${lib})\n    at ${caller}`;
it("Vite 개발 서버의 주소와 ?t= 를 뗀다", () =>
  expect(labelFromStack(at("http://localhost:5173/node_modules/.vite/deps/supa-store.js?v=1a2b:120:9",
    "http://localhost:5173/src/app/a.action.ts?t=1731111111:12:5"))).toBe("src/app/a.action.ts:12"));
it("webpack-internal 과 (app-pages-browser) 를 뗀다", () =>
  expect(labelFromStack(at("webpack-internal:///(app-pages-browser)/./node_modules/supa-store/dist/index.js:200:3",
    "webpack-internal:///(app-pages-browser)/./src/b.state.ts:7:1"))).toBe("src/b.state.ts:7"));
it("file:// 를 떼고 Windows 역슬래시를 / 로 바꾼다", () => {
  expect(labelFromStack(at("file:///C:/x/dist/index.js:1:1", "file:///C:/x/src/c.ts:3:9"))).toBe("C:/x/src/c.ts:3");
  expect(labelFromStack(at("C:\\x\\dist\\index.js:1:1", "C:\\x\\src\\c.ts:3:9"))).toBe("C:/x/src/c.ts:3");
});
it("라이브러리 파일의 프레임이 여럿이어도 건너뛴다", () =>
  expect(labelFromStack("Error\n    at f (/lib/index.js:1:1)\n    at g (/lib/index.js:9:1)\n    at /app/d.ts:4:2")).toBe("/app/d.ts:4"));
it("Firefox 꼴(fn@url:line:col)도 읽는다", () =>
  expect(labelFromStack("createStore@http://h/lib.js:1:1\n@http://h/src/e.ts?t=9:5:1")).toBe("src/e.ts:5"));
it("읽지 못하면 null", () => {
  expect(labelFromStack(undefined)).toBeNull();
  expect(labelFromStack("Error")).toBeNull();
});
