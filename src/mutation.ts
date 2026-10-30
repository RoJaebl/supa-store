// 바꾸기 하나의 상태 — 자원이 쥐고, 어디서 부르든 같은 칸을 거친다. React 를 가져오지 않는다
type Fn = (...args: any[]) => any;

/** 바꾸기 하나의 상태 — 바뀔 때마다 새 객체다 */
export interface MutationSnapshot<F extends Fn> {
  /** 보냈지만 아직 끝나지 않은 호출들의 인자 — 보낸 차례대로 선다 */
  readonly inflight: readonly Parameters<F>[];
  readonly pending: boolean;
  /** 마지막으로 끝난 호출이 실패했으면 그 문구 */
  readonly error: string | null;
  /** 마지막으로 끝난 호출이 성공했으면 그 결과 */
  readonly data: Awaited<ReturnType<F>> | undefined;
}
/** 부를 수 있는 바꾸기 — 상태 칸은 읽기 전용 속성 */
export type MutationFn<F extends Fn> = F & MutationSnapshot<F> & { reset(): void };
export interface MutationHooks<F extends Fn> {
  onSuccess?: (result: Awaited<ReturnType<F>>, ...args: Parameters<F>) => void;
  onError?: (error: unknown, ...args: Parameters<F>) => void;
  onSettled?: (result: Awaited<ReturnType<F>> | undefined, error: unknown, ...args: Parameters<F>) => void;
  /** 같은 id 의 바꾸기를 한 줄에 세운다 */
  scope?: { id: string };
}
/** 구독 단위 — 화면 훅과 읽기 기록이 쓴다 */
export interface MutationChannel {
  subscribe(listener: () => void): () => void;
  snapshot(): MutationSnapshot<Fn>;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 지금 도는 track 이 모으는 칸 — track 바깥이면 null 이라 읽어도 적지 않는다 */
let recording: Set<MutationChannel> | null = null;
/** 상태 칸을 읽었다고 적는다 — track 이 도는 동안에만 */
export function noteRead(channel: MutationChannel): void {
  recording?.add(channel);
}
/** run 이 도는 동안 읽힌 바꾸기 칸을 모은다. 겹쳐 부르면 안쪽 것만 모은다 */
export function track<T>(run: () => T): { value: T; reads: MutationChannel[] } {
  const outer = recording;
  const mine = new Set<MutationChannel>();
  recording = mine;
  try {
    return { value: run(), reads: [...mine] };
  } finally {
    recording = outer;
  }
}

/** scope.id → 그 줄 마지막 호출이 끝나면 풀리는 약속 — 던지지 않는다 */
const scopes = new Map<string, Promise<void>>();
/** 시험 사이에 줄이 남지 않도록 비운다 */
export function resetScopes(): void {
  scopes.clear();
}

const FIELDS = ["inflight", "pending", "error", "data"] as const;

/** 콜백이 던져도 호출의 결과와 inflight 를 붙잡지 않는다 — 콘솔에 남기고 삼킨다 */
function safely(cb: Fn | undefined, ...args: unknown[]) {
  try {
    cb?.(...args);
  } catch (e) {
    console.error(e);
  }
}

/**
 * 바꾸기 함수를 감싸 상태 칸을 쥔다. 호출마다 안쪽 번호를 매긴다 — 같은 인자로 두 번 불러도 끝난 쪽만 inflight 에서 빼고,
 * 더 나중 번호가 이미 끝났으면 그 응답은 늦은 것이라 칸과 콜백을 건드리지 않는다. reset 앞에 보낸 호출은 칸에만 적지 않는다
 */
export function createMutation<F extends Fn>(
  fn: F,
  hooks: MutationHooks<F> = {},
): { call: MutationFn<F>; channel: MutationChannel } {
  const listeners = new Set<() => void>();
  let state: MutationSnapshot<F> = { inflight: [], pending: false, error: null, data: undefined };
  let calls: { n: number; args: Parameters<F> }[] = [];
  let sent = 0;
  /** 끝난 가장 큰 번호 — 이보다 작거나 같은 호출의 응답은 늦은 것이라 칸도 콜백도 건드리지 않는다 */
  let done = 0;
  /** reset 할 때 보낸 가장 큰 번호 — 이보다 작거나 같은 호출은 칸에 적지 않지만 콜백은 부른다 */
  let floor = 0;

  const write = (patch: Partial<MutationSnapshot<F>>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const line = (next: typeof calls, patch: Partial<MutationSnapshot<F>> = {}) => {
    calls = next;
    write({ ...patch, inflight: next.map((c) => c.args), pending: next.length > 0 });
  };
  const channel: MutationChannel = {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => state,
  };

  const call = async (...args: Parameters<F>) => {
    const n = ++sent;
    // 다시 부르면 앞 실패의 문구를 지운다 — 0.2 의 화면별 바꾸기와 같다
    line([...calls, { n, args }], { error: null });
    // 같은 scope 의 앞 호출이 끝나기를 기다린다 — 앞이 실패해도 줄은 풀린다
    const id = hooks.scope?.id;
    const prev = id === undefined ? undefined : scopes.get(id);
    let release = () => {};
    if (id !== undefined) {
      const mine = new Promise<void>((r) => (release = () => (scopes.get(id) === mine && scopes.delete(id), r())));
      scopes.set(id, mine);
    }
    try {
      if (prev) await prev;
      const result = await fn(...args);
      if (n > done) {
        done = n;
        if (n > floor) write({ data: result, error: null });
        safely(hooks.onSuccess, result, ...args);
        safely(hooks.onSettled, result, null, ...args);
      }
      return result;
    } catch (e) {
      if (n > done) {
        done = n;
        if (n > floor) write({ error: message(e) });
        safely(hooks.onError, e, ...args);
        safely(hooks.onSettled, undefined, e, ...args);
      }
      throw e;
    } finally {
      // 칸과 콜백이 먼저 — 그 뒤에 빠져야 캐시가 서버 값이 된 다음 겹이 빠진다
      line(calls.filter((c) => c.n !== n));
      release();
    }
  };
  for (const field of FIELDS) {
    Object.defineProperty(call, field, {
      get() {
        noteRead(channel);
        return state[field];
      },
    });
  }
  // 앞서 떠난 호출이 칸에 적지 못하게 한다 — 그 콜백은 돈다. inflight 는 그 호출이 끝날 때 빠진다
  const reset = () => {
    floor = sent;
    write({ error: null, data: undefined });
  };
  return { call: Object.assign(call, { reset }) as unknown as MutationFn<F>, channel };
}
