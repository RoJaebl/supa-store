// SSE 의 글자 — 두 진입점(node · web)이 함께 쓰는 한 벌. 프레임 쓰기와, GET 요청의 헤더를 hello 로 읽기
import { HEADER, type ClientMessage, type ServerMessage } from "../stream/protocol.js";

/** 메시지 하나를 이벤트 하나로 — data: 한 줄 JSON. snapshot · change 에는 id: 버전을 붙여 Last-Event-ID 로 돌아오게 한다
 *  갈래는 JSON 의 t 가 가르므로 event: 줄은 쓰지 않는다. JSON.stringify 는 줄바꿈을 \n 으로 바꾸므로 data: 는 늘 한 줄이다 */
export function sseFrame(m: ServerMessage): string {
  const id = m.t === "snapshot" || m.t === "change" ? `id: ${m.version}\n` : "";
  return `${id}data: ${JSON.stringify(m)}\n\n`;
}

/** Authorization 의 토큰 — Bearer 머리는 떼고 읽는다 */
export function tokenOf(headers: Record<string, string | undefined>): string | undefined {
  const v = headers[HEADER.authorization];
  return v?.replace(/^Bearer\s+/i, "") || undefined;
}

/** SSE 는 GET 요청이 hello 다 — 채널 · epoch · 버전(Last-Event-ID) · 토큰을 헤더에서 읽는다 */
export function helloFromHeaders(headers: Record<string, string | undefined>): Extract<ClientMessage, { t: "hello" }> {
  const last = headers[HEADER.lastEventId];
  const version = last === undefined || last === "" ? undefined : Number(last);
  return {
    t: "hello",
    channel: headers[HEADER.channel] || undefined,
    epoch: headers[HEADER.epoch] || undefined,
    version: Number.isInteger(version) ? version : undefined,
    auth: tokenOf(headers),
  };
}
