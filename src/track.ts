// 계산 공간 — 도는 동안 읽힌 것을 적는다. 자원 select 와 파생 store 가 이 안에서 돈다. React 를 가져오지 않는다

/** 읽은 것 하나 — store · 바꾸기 칸 · 자원 칸이 저마다 낸다 */
export interface Channel {
  subscribe(listener: () => void): () => void;
  /** 이 값이 앞과 같으면(Object.is) 읽은 것이 그대로다 */
  snapshot(): unknown;
  /** 계산 공간이 이 채널을 구독하는 동안 부른다. 돌려준 함수가 보기를 푼다 — 자원 칸만 둔다 */
  watch?(): () => void;
}

/** 파생 store 의 상태가 이 표식으로 자기 채널을 둔다 — ctx 가 파생을 알아보고 값을 꺼낸다 */
export const DERIVED: unique symbol = Symbol.for("supa-store.derived") as never;

/** 지금 도는 track 이 모으는 채널 — track 바깥이면 null 이라 읽어도 적지 않는다 */
let recording: Set<Channel> | null = null;

/** 읽었다고 적는다 — track 이 도는 동안에만 */
export function noteRead(channel: Channel): void {
  recording?.add(channel);
}

/** run 이 도는 동안 읽힌 채널을 모은다. 겹쳐 부르면 안쪽 것만 모은다 */
export function track<T>(run: () => T): { value: T; reads: Channel[] } {
  const outer = recording;
  const mine = new Set<Channel>();
  recording = mine;
  try {
    return { value: run(), reads: [...mine] };
  } finally {
    recording = outer;
  }
}
