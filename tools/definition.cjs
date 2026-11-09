// isDefinition — 파일이 supa-store 에서 createStore 를 가져오면 정의 파일이다.
// 정규식으로 가린다. 넘치는 쪽(정의가 아닌데 참)은 다시 읽기가 한 번 늘 뿐이라 덜 위험하다.
// 이름 공간으로 가져오면(`import * as s`) createStore 를 쓰는지 보지 않고 정의로 친다.
// 다시 내보내기(`export { createStore } from`)와 동적 import 는 알아보지 못한다
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']supa-store["']/g;
const NAMESPACE = /import\s*\*\s*as\s+[\w$]+\s+from\s*["']supa-store["']/;

function isDefinition(code) {
  if (NAMESPACE.test(code)) return true;
  for (const [, names] of code.matchAll(IMPORT)) if (/\bcreateStore\b/.test(names)) return true;
  return false;
}

module.exports = { isDefinition };
