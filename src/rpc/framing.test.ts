// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createReader, encode } from "./framing.js";

const collect = (framing: "content-length" | "ndjson") => {
  const out: string[] = [];
  return { out, feed: createReader(framing, (t) => out.push(t)) };
};

describe("content-length", () => {
  it("두 메시지를 한 조각으로 붙여도 두 번 알린다", () => {
    const { out, feed } = collect("content-length");
    feed(Buffer.concat([encode("content-length", "{}"), encode("content-length", '{"a":1}')]));
    expect(out).toEqual(["{}", '{"a":1}']);
  });

  it("1바이트씩 넣어도 한 번 알린다", () => {
    const { out, feed } = collect("content-length");
    for (const b of encode("content-length", '{"a":1}')) feed(Buffer.from([b]));
    expect(out).toEqual(['{"a":1}']);
  });

  it("길이는 바이트 수이고 한글이 조각에 걸쳐도 맞다", () => {
    const text = '{"a":"한글"}';
    const buf = encode("content-length", text);
    expect(buf.toString().startsWith("Content-Length: 14\r\n")).toBe(true);
    const { out, feed } = collect("content-length");
    const cut = buf.indexOf(Buffer.from("한")) + 1; // 한 글자의 중간
    feed(buf.subarray(0, cut));
    feed(buf.subarray(cut));
    expect(out).toEqual([text]);
  });

  it("소문자 머리와 다른 머리가 섞여도 읽는다", () => {
    const { out, feed } = collect("content-length");
    feed(Buffer.from("content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}"));
    expect(out).toEqual(["{}"]);
  });

  it("길이 없는 머리는 버리고 다음을 읽는다", () => {
    const { out, feed } = collect("content-length");
    feed(Buffer.concat([Buffer.from("X-Foo: 1\r\n\r\n"), encode("content-length", "{}")]));
    expect(out).toEqual(["{}"]);
  });
});

describe("content-length 깨진 머리와 큰 메시지", () => {
  const ok = encode("content-length", "{}");
  const BAD = ["Content-Length: -5", "Content-Length: abc", "Content-Length: 99999999999999999999"];
  it.each(BAD)("깨진 머리 %s 뒤의 정상 메시지를 읽는다", (bad) => {
    const { out, feed } = collect("content-length");
    feed(Buffer.from(`${bad}\r\n\r\n`));
    feed(ok);
    expect(out).toEqual(["{}"]);
  });
  it("8 KiB 넘는 쓰레기 뒤의 정상 메시지를 읽는다", () => {
    const { out, feed } = collect("content-length");
    feed(Buffer.alloc(9000, "x"));
    feed(ok);
    expect(out).toEqual(["{}"]);
  });
  it("길이 0 은 알리지 않는다", () => {
    const { out, feed } = collect("content-length");
    feed(Buffer.concat([Buffer.from("Content-Length: 0\r\n\r\n"), ok]));
    expect(out).toEqual(["{}"]);
  });
  it("1 MiB 메시지를 1 KiB 조각으로 넣어도 하나 알린다", () => {
    const text = JSON.stringify({ a: "가".repeat(350_000) });
    const buf = encode("content-length", text);
    const { out, feed } = collect("content-length");
    for (let i = 0; i < buf.length; i += 1024) feed(buf.subarray(i, i + 1024));
    expect(out).toEqual([text]);
  });
});

describe("ndjson", () => {
  it("1 MiB 한 줄을 1 KiB 조각으로 넣어도 하나 알린다", () => {
    const text = JSON.stringify({ a: "가".repeat(350_000) });
    const buf = encode("ndjson", text);
    const { out, feed } = collect("ndjson");
    for (let i = 0; i < buf.length; i += 1024) feed(buf.subarray(i, i + 1024));
    expect(out).toEqual([text]);
  });
  it("줄마다 알린다", () => {
    const { out, feed } = collect("ndjson");
    feed(Buffer.from("{}\n{}\n"));
    expect(out).toEqual(["{}", "{}"]);
  });
  it("CRLF 는 걷고 빈 줄은 알리지 않는다", () => {
    const { out, feed } = collect("ndjson");
    feed(Buffer.from("{}\r\n\n\r\n"));
    expect(out).toEqual(["{}"]);
  });
  it("줄이 조각에 걸쳐도 맞다", () => {
    const { out, feed } = collect("ndjson");
    const b = Buffer.from('{"a":"한"}\n');
    feed(b.subarray(0, 8));
    feed(b.subarray(8));
    expect(out).toEqual(['{"a":"한"}']);
  });
  it("encode 는 줄바꿈을 붙인다", () => {
    expect(encode("ndjson", "{}").toString()).toBe("{}\n");
  });
});
