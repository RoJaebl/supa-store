// webpack loader — 정의 파일(createStore 를 가져오는 파일)이 HMR 갱신을 받지 않게 한다.
// 정의 모듈이 다시 실행되면 store 가 하나 더 생기므로, 갱신은 여기서 멈추고 페이지를 통째로 다시 읽는다
const { isDefinition } = require("./definition.cjs");

module.exports = function declineLoader(source) {
  if (!isDefinition(source)) return source;
  return `${source}\nif (import.meta.webpackHot) import.meta.webpackHot.decline();\n`;
};
