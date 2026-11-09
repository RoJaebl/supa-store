// 부른 자리에서 store 의 이름을 읽는다. 오류 메시지에 store 를 가리키는 데만 쓴다.

type Frame = { path: string; line: string };

/** 위치 문자열 `<경로>:<줄>:<열>` 을 다듬은 경로와 줄로 가른다. 꼴이 아니면 null. */
function parseLocation(loc: string): Frame | null {
  const m = /^(.*):(\d+):\d+$/.exec(loc.trim());
  if (!m) return null;
  const path = m[1]!
    .replace(/\\/g, "/")
    .replace(/\?.*$/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^webpack-internal:\/\/\//, "")
    .replace(/^\([^)]*\)\//, "")
    .replace(/^\.\//, "")
    .replace(/^file:\/\/\/(?=[A-Za-z]:)/, "")
    .replace(/^file:\/\//, "");
  return { path, line: m[2]! };
}

/** 한 줄에서 위치를 뽑는다. V8(`at fn (위치)` · `at 위치`)과 Firefox(`fn@위치`)를 읽는다. */
function parseFrame(text: string): Frame | null {
  const t = text.trim();
  const v8 = /^at (?:.*? \()?(.*?)\)?$/.exec(t);
  if (v8) return parseLocation(v8[1]!);
  const at = t.indexOf("@");
  return at < 0 ? null : parseLocation(t.slice(at + 1));
}

/**
 * `new Error().stack` 에서 첫 프레임(이 stack 을 만든 라이브러리 파일)과 다른 파일의
 * 첫 프레임을 `<경로>:<줄>` 로 돌려준다. 가려내지 못하면 null.
 */
export function labelFromStack(stack: string | undefined): string | null {
  if (!stack) return null;
  const frames = stack.split("\n").map(parseFrame).filter((f): f is Frame => f !== null);
  const own = frames[0]?.path;
  const caller = frames.find((f) => f.path !== own);
  return caller ? `${caller.path}:${caller.line}` : null;
}
