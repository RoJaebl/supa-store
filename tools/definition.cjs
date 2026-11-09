// isDefinition — 파일이 supa-store 에서 createStore 를 가져오면 정의 파일이다.
// 정규식으로 가린다. 넘치는 쪽(정의가 아닌데 참)은 다시 읽기가 한 번 늘 뿐이라 덜 위험하다
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']supa-store["']/g;

function isDefinition(code) {
  for (const [, names] of code.matchAll(IMPORT)) if (/\bcreateStore\b/.test(names)) return true;
  return false;
}

module.exports = { isDefinition };
