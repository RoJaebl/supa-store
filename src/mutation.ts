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

/** 상태 칸을 읽었다고 적는 자리 — 아직 아무것도 하지 않는다 */
export function noteRead(_channel: MutationChannel): void {}

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
 * 더 나중 번호가 이미 끝났으면(또는 reset 했으면) 그 응답은 늦은 것이라 칸과 콜백을 건드리지 않는다
 */
export function createMutation<F extends Fn>(
  fn: F,
  hooks: MutationHooks<F> = {},
): { call: MutationFn<F>; channel: MutationChannel } {
  const listeners = new Set<() => void>();
  let state: MutationSnapshot<F> = { inflight: [], pending: false, error: null, data: undefined };
  let calls: { n: number; args: Parameters<F> }[] = [];
  let sent = 0;
  /** 끝난(또는 reset 한) 가장 큰 번호 — 이보다 작거나 같은 호출의 응답은 늦은 것이다 */
  let done = 0;

  const write = (patch: Partial<MutationSnapshot<F>>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const line = (next: typeof calls) => {
    calls = next;
    write({ inflight: next.map((c) => c.args), pending: next.length > 0 });
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
    line([...calls, { n, args }]);
    try {
      const result = await fn(...args);
      if (n > done) {
        done = n;
        write({ data: result, error: null });
        safely(hooks.onSuccess, result, ...args);
        safely(hooks.onSettled, result, null, ...args);
      }
      return result;
    } catch (e) {
      if (n > done) {
        done = n;
        write({ error: message(e) });
        safely(hooks.onError, e, ...args);
        safely(hooks.onSettled, undefined, e, ...args);
      }
      throw e;
    } finally {
      // 칸과 콜백이 먼저 — 그 뒤에 빠져야 캐시가 서버 값이 된 다음 겹이 빠진다
      line(calls.filter((c) => c.n !== n));
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
  // 차례를 올려 앞서 떠난 호출의 결과를 받지 않는다. inflight 는 그 호출이 끝날 때 빠진다
  const reset = () => {
    done = sent;
    write({ error: null, data: undefined });
  };
  return { call: Object.assign(call, { reset }) as unknown as MutationFn<F>, channel };
}
