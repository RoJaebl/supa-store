// 정의 도우미 — 정의 파일은 서버 쪽에서도 평가되므로 "use client" 를 두지 않는다. 훅은 [USE] 안에서만 부른다
// 훅은 resourceHook.ts 에 산다 — 서버 층에서도 링크가 깨지지 않게 React 를 이름공간으로 가져온다
import { USE } from "./index.js";
import { IDLE, makeResourceHook, message, noop, QUERY_FIELDS } from "./resourceHook.js";

type Fn = (...args: any[]) => any;

// ── event ─────────────────────────────────────────────

export interface Event<P> {
  /** 반응하는 store 들을 부른다 */
  emit(payload: P): void;
  /** who(store key)가 반응한다. 같은 who 가 다시 걸면 앞 것을 갈아 끼운다. 풀기 함수를 돌려준다 */
  on(who: string, fn: (payload: P) => void): () => void;
  /** who 는 일부러 반응하지 않는다 — 실행에는 영향이 없고 결정이라는 기록만 남긴다 */
  exempt(who: string, why: string): void;
  /** 출력 스냅숏이 읽는다. 둘 다 who 로 정렬한다 */
  record(): { on: string[]; exempt: Array<{ who: string; why: string }> };
}

/** 자원 사이를 잇는 event. createStore(key, () => createEvent<P>()) 로 둔다 */
export function createEvent<P>(): Event<P> {
  const handlers = new Map<string, (payload: P) => void>();
  const exempts = new Map<string, string>();
  return {
    emit: (payload) => [...handlers.values()].forEach((fn) => fn(payload)),
    on(who, fn) {
      if (exempts.has(who)) throw new Error(`${who} 는 이미 exempt 했다 — on 과 함께 적을 수 없다`);
      handlers.set(who, fn);
      return () => void (handlers.get(who) === fn && handlers.delete(who));
    },
    exempt(who, why) {
      if (handlers.has(who)) throw new Error(`${who} 는 이미 on 했다 — exempt 와 함께 적을 수 없다`);
      exempts.set(who, why);
    },
    record: () => ({
      on: [...handlers.keys()].sort(),
      exempt: [...exempts.keys()].sort().map((who) => ({ who, why: exempts.get(who)! })),
    }),
  };
}

// ── 자원 ──────────────────────────────────────────────

export interface Cache<A, D> {
  /** args 하나면 값 하나, 배열이면 같은 순서의 값 배열 */
  getData(args?: A): D | undefined;
  getData(args: readonly A[]): (D | undefined)[];
  /** 응답이 실어 온 값으로 바로 고친다 — 다시 받지 않는다. 배열이면 args 마다 updater 를 부른다 */
  setData(updater: D | ((prev: D | undefined, args: A) => D | undefined), args?: A | readonly A[]): void;
  /** 다시 받는다 — args 를 주면 그 칸만(배열이면 그 칸들만, 빈 배열은 아무것도 안 함), 없으면 받아 둔 칸 모두. 실패는 칸의 error 에 둔다 */
  invalidate(args?: A | readonly A[]): Promise<void>;
  /** 받아서 칸에 넣고 값을 돌려준다 — 이미 받은 칸이면 그 값을 바로 준다(체인에서 쓴다). 실패하면 던진다. 배열이면 하나라도 실패할 때 그 오류로 거절한다 */
  fetch(args?: A): Promise<D>;
  fetch(args: readonly A[]): Promise<D[]>;
}

export type Status = "idle" | "loading" | "ready" | "error";
export interface QueryView<D> {
  data: D | undefined;
  status: Status;
  error: string | null;
  /** 자리를 채운 값이면 true — 이 판에서는 늘 false 다 */
  isPlaceholderData: boolean;
  refetch(): Promise<void>;
}
export type QueryField = "data" | "status" | "error" | "isPlaceholderData" | "refetch";
export interface MutationView<F extends Fn> {
  /** 아무것도 돌려주지 않는다 — 실패는 error 에만 둔다. 결과가 필요하면 mutateAsync */
  mutate(...args: Parameters<F>): void;
  /** 결과를 돌려주고 실패하면 원래 오류를 던진다. error·data 칸도 mutate 와 같이 채운다 */
  mutateAsync(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
  pending: boolean;
  error: string | null;
  data: Awaited<ReturnType<F>> | undefined;
  reset(): void;
}
/** 정의한 객체에서 query 를 뺀 함수 칸 — 바꾸기 */
export type Mutations<R> = { [K in keyof R as K extends "query" ? never : R[K] extends Fn ? K : never]: R[K] };
// & Fn 으로 좁히면 겹친 서명의 마지막인 Fn 이 ReturnType 을 정해 data 가 any 가 된다 — Extract 로 좁힌다
export type ResourceView<D, R> = QueryView<D> & { [K in keyof Mutations<R>]: MutationView<Extract<Mutations<R>[K], Fn>> };
type ViewName<D, R> = keyof ResourceView<D, R> & string;
/** 하나 꼴 — 조회 칸과 바꾸기 칸을 고른다 */
export type ResourceOptions<A, N extends string> =
  | { args?: A; pick?: readonly N[]; omit?: never }
  | { args?: A; omit?: readonly N[]; pick?: never };
/** 목록 꼴 — 조회 칸만 고른다. 바꾸기는 자원 전체에 하나라 항목에 넣지 않는다 */
export type ResourceListOptions<A> =
  | { args: readonly A[]; pick?: readonly QueryField[]; omit?: never }
  | { args: readonly A[]; omit?: readonly QueryField[]; pick?: never };
// [O] 로 감싸 유니온에 나눠 걸지 않는다 — ReturnType 이 제약으로 읽으면 다 고른 하나 꼴이 된다
type Chosen<V, O> = [O] extends [{ pick: readonly (infer N)[] }]
  ? Pick<V, N & keyof V>
  : [O] extends [{ omit: readonly (infer N)[] }]
    ? Omit<V, N & keyof V>
    : V;
export type PickedView<D, R, O> = Chosen<ResourceView<D, R>, O>;
export type PickedQuery<D, O> = Chosen<QueryView<D>, O>;
export type ResourceUseOptions<A, D, R> = ResourceOptions<A, ViewName<D, R>> | ResourceListOptions<A> | undefined;
export type ResourceUseResult<D, R, O> = [O] extends [{ args: readonly unknown[] }]
  ? PickedQuery<D, O>[]
  : PickedView<D, R, O>;
/** 자원의 꺼내기 — 서명 하나다. 입력이 목록이면 배열을 돌려준다 */
export interface ResourceUse<A, D, R> {
  <O extends ResourceUseOptions<A, D, R> = undefined>(options?: O): ResourceUseResult<D, R, O>;
}
/** store 끼리·시험이 보는 자원의 모양. 화면은 useStore 로 꺼내 ResourceView 를 받는다 */
export type Resource<A, D, R> = Cache<A, D> & Mutations<R> & { [USE]: ResourceUse<A, D, R> };

const RESERVED = [...QUERY_FIELDS, "fetch", "getData", "setData", "invalidate"];

interface Cell<A, D> {
  args: A | undefined;
  view: { data: D | undefined; status: Status; error: string | null };
  /** 요청 차례 — 이 차례가 아닌 응답은 버린다 */
  seq: number;
  inflight?: Promise<D>;
}

/**
 * 자원 하나를 정의한다. `query` 가 조회 하나이고, 나머지 함수가 모두 바꾸기다.
 *
 * `cache` 를 쓰면 인자에 타입을 적는다 — 한 호출 안에서는 TypeScript 가 `query` 에서 `cache` 의 타입을 추론하지 못한다.
 * ```ts
 * createResource((cache: Cache<void, Pick[]>) => ({
 *   query: async () => …,                                   // Pick[] 을 돌려준다
 *   async save(numbers: number[]) { cache.setData((prev) => …) },
 * }))
 * createResource(() => ({ query: async (id: string) => … })) // cache 를 쓰지 않으면 적지 않는다
 * ```
 * 함수는 늘 정의한 객체를 this 로 부른다 — 메서드 꼴은 this.다른함수() 를 쓸 수 있다.
 */
export function createResource<A = void, D = never, R extends object = object>(
  define: (cache: Cache<A, D>) => R & { query?: (args: A) => Promise<D> },
  options: { auto?: boolean } = {},
): Resource<A, D, R> {
  const auto = options.auto ?? true;
  const cells = new Map<string, Cell<A, D>>();
  const listeners = new Set<() => void>();
  const idOf = (args: A | undefined) => JSON.stringify(args ?? null);
  const cellOf = (args: A | undefined): Cell<A, D> => {
    const id = idOf(args);
    let cell = cells.get(id);
    if (!cell) cells.set(id, (cell = { args, view: IDLE, seq: 0 }));
    return cell;
  };
  const write = (cell: Cell<A, D>, view: Partial<Cell<A, D>["view"]>) => {
    cell.view = { ...cell.view, ...view };
    listeners.forEach((l) => l());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  /** 받는다. 진행 중인 요청이 있으면 그것을 나눠 쓰고, force 면 새로 보내 앞 요청의 응답을 버린다 */
  const load = (args: A | undefined, force = false): Promise<D> => {
    const cell = cellOf(args);
    if (cell.inflight && !force) return cell.inflight;
    const seq = ++cell.seq;
    write(cell, { status: "loading", error: null });
    // 실행자는 곧바로 돈다 — query 가 동기로 던져도 거절로 바뀐다
    const request = new Promise<D>((resolve) => resolve(query!.call(defined, args as A)))
      .then(
        (data) => {
          if (cell.seq === seq) write(cell, { data, status: "ready" });
          return data;
        },
        (e) => {
          if (cell.seq === seq) write(cell, { status: "error", error: message(e) });
          throw e;
        },
      )
      .finally(() => {
        if (cell.inflight === request) cell.inflight = undefined;
      });
    cell.inflight = request;
    return request;
  };

  // 목록은 Array.isArray 로 가른다 — 생성기가 args 자체가 배열인 자원을 막는다
  const getOne = (args: A | undefined) => cells.get(idOf(args))?.view.data;
  const setOne = (updater: unknown, args: A | undefined) => {
    const cell = cellOf(args);
    const data =
      typeof updater === "function" ? (updater as (prev: D | undefined, a: A) => D | undefined)(cell.view.data, args as A) : (updater as D);
    // 차례를 올려 이 앞에 떠난 조회의 늦은 응답이 고친 값을 덮지 못하게 한다
    cell.seq += 1;
    // 값을 비우면(받은 적 없는 목록으로 되돌리기) 처음으로 돌린다 — 버린 응답 탓에 loading 에 갇히지 않고 다음에 다시 받는다
    write(cell, { data, status: data === undefined ? "idle" : "ready", error: null });
  };
  const reload = (cell: Cell<A, D>) => (cell.view.status === "idle" ? undefined : load(cell.args, true).catch(noop));
  const fetchOne = (args: A | undefined) => {
    const cell = cellOf(args);
    return cell.view.status === "ready" ? Promise.resolve(cell.view.data as D) : load(args);
  };

  const cache = {
    getData: (args?: A | readonly A[]) => (Array.isArray(args) ? args.map(getOne) : getOne(args as A | undefined)),
    setData(updater: unknown, args?: A | readonly A[]) {
      if (Array.isArray(args)) args.forEach((a) => setOne(updater, a));
      else setOne(updater, args as A | undefined);
    },
    async invalidate(args?: A | readonly A[]) {
      const targets = args === undefined ? [...cells.values()] : (Array.isArray(args) ? args : [args]).map((a) => cellOf(a));
      await Promise.all(targets.map(reload));
    },
    fetch: (args?: A | readonly A[]) => (Array.isArray(args) ? Promise.all(args.map(fetchOne)) : fetchOne(args as A | undefined)),
  } as Cache<A, D>;

  const defined = define(cache) as Record<string, unknown>;
  const query = defined.query as ((args: A) => Promise<D>) | undefined;
  const mutations: Record<string, Fn> = {};
  for (const [name, value] of Object.entries(defined)) {
    if (name === "query" || typeof value !== "function") continue;
    if (RESERVED.includes(name)) throw new Error(`바꾸기 이름으로 쓸 수 없다: ${name}`);
    mutations[name] = (value as Fn).bind(defined);
  }
  const names = Object.keys(mutations);

  const useResource = makeResourceHook({ cellOf, load, subscribe, idOf, query, auto, mutations, names });
  return Object.assign(cache, mutations, { [USE]: useResource }) as unknown as Resource<A, D, R>;
}
