export type Framing = "content-length" | "ndjson";

const SEP = Buffer.from("\r\n\r\n");

/** 조각을 쌓아 메시지가 다 차면 글자로 알린다 */
export function createReader(framing: Framing, onMessage: (text: string) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (framing === "ndjson") {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        buf = buf.subarray(nl + 1);
        if (line) onMessage(line);
        continue;
      }
      const end = buf.indexOf(SEP);
      if (end < 0) return;
      const len = /^content-length:\s*(\d+)/im.exec(buf.subarray(0, end).toString("latin1"))?.[1];
      if (len === undefined) { // 길이 없는 머리는 버린다
        buf = buf.subarray(end + 4);
        continue;
      }
      const start = end + 4;
      if (buf.length < start + Number(len)) return;
      const body = buf.subarray(start, start + Number(len)).toString("utf8");
      buf = buf.subarray(start + Number(len));
      onMessage(body);
    }
  };
}

export function encode(framing: Framing, text: string): Buffer {
  if (framing === "ndjson") return Buffer.from(`${text}\n`, "utf8");
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1"), body]);
}
