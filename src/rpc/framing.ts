export type Framing = "content-length" | "ndjson";

const SEP = Buffer.from("\r\n\r\n");

const HEAD_MAX = 8192; // 머리 자리에 이보다 쌓이면 깨진 것으로 본다(본문 · 한 줄에는 상한이 없다)

/** 조각을 쌓아 메시지가 다 차면 글자로 알린다 */
export function createReader(framing: Framing, onMessage: (text: string) => void): (chunk: Buffer) => void {
  // 아직 다 차지 않은 것을 조각째 모아 둔다 — 조각마다 전체를 복사하지 않는다
  let parts: Buffer[] = [];
  let need = -1; // content-length: 본문을 기다리는 중이면 그 길이, 머리를 찾는 중이면 -1
  let got = 0;

  const ndjson = (chunk: Buffer) => {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from); // 새로 온 조각에서만 찾는다
      if (nl < 0) break;
      parts.push(chunk.subarray(from, nl));
      const line = Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
      parts = [];
      if (line) onMessage(line);
      from = nl + 1;
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
  };

  const lengthed = (chunk: Buffer) => {
    while (chunk.length) {
      if (need >= 0) {
        const take = Math.min(chunk.length, need - got);
        parts.push(chunk.subarray(0, take));
        got += take;
        chunk = chunk.subarray(take);
        if (got < need) return;
        const body = Buffer.concat(parts).toString("utf8");
        parts = [];
        need = -1;
        got = 0;
        if (body) onMessage(body);
        continue;
      }
      // 머리를 찾는 중 — 머리는 작아서 이어 붙여도 싸다
      const head = Buffer.concat([...parts, chunk]);
      const end = head.indexOf(SEP);
      if (end < 0) {
        parts = head.length > HEAD_MAX ? [] : [head];
        return;
      }
      const len = end > HEAD_MAX ? undefined : /^content-length:[ \t]*(\d+)/im.exec(head.subarray(0, end).toString("latin1"))?.[1];
      const n = len === undefined ? NaN : Number(len);
      parts = [];
      chunk = head.subarray(end + 4);
      if (Number.isSafeInteger(n)) need = n; // 길이 없는 · 깨진 머리는 버린다
    }
  };

  return framing === "ndjson" ? ndjson : lengthed;
}

export function encode(framing: Framing, text: string): Buffer {
  if (framing === "ndjson") return Buffer.from(`${text}\n`, "utf8");
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1"), body]);
}
