// 정의 도우미 — 정의 파일은 서버 쪽에서도 평가되므로 "use client" 를 두지 않는다. 훅은 [USE] 안에서만 부른다
// 훅은 resourceHook.ts 에 살고, 이 파일은 React 를 가져오지 않는다
import { USE } from "./index.js";
import { createRefetcher, type RefetchInterval } from "./refetch.js";
import { IDLE, makeResourceHook, message, noop, QUERY_FIELDS } from "./resourceHook.js";

export type { RefetchInterval };

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
  /** 응답이 실어 온 값으로 바로 고친다 — 다시 받지 않는다. 배열이면 args 마다 updater 를 부른다. undefined 면 그 칸을 비워 idle 로. 낡음은 끄지 않는다 */
  setData(updater: D | undefined | ((prev: D | undefined, args: A) => D | undefined), args?: A | readonly A[]): void;
  /**
   * 무효화한다 — args 를 주면 그 칸만(배열이면 그 칸들만, 빈 배열은 아무것도 안 함), 함수면 참인 칸, 없으면 받아 둔 칸 모두.
   * 화면이 보는 칸은 곧바로 다시 받고(이것만 기다린다), 보지 않는 칸은 값을 두고 낡음만 표시해 다시 볼 때 · fetch 할 때 받는다.
   * 실패는 칸의 error 에 둔다
   */
  invalidate(args?: A | readonly A[] | ((args: A) => boolean)): Promise<void>;
  /** 받아서 칸에 넣고 값을 돌려준다 — 받는 중이면 끝을 기다려 칸의 값을, 아니고 이미 받은 칸이면 그 값을 바로 준다(체인에서 쓴다). 실패하면 던진다. 배열이면 하나라도 실패할 때 그 오류로 거절한다 */
  fetch(args?: A): Promise<D>;
  fetch(args: readonly A[]): Promise<D[]>;
}

export type Status = "idle" | "loading" | "ready" | "error";
export interface QueryView<D> {
  data: D | undefined;
  status: Status;
  error: string | null;
  /** 보이는 data 가 받은 값이 아니라 자리를 채운 값이면 true */
  isPlaceholderData: boolean;
  /** 그 args 의 요청이 진행 중이면 true — 처음 받을 때도. 값이 있는 동안 다시 받아도 status 는 그대로다 */
  isFetching: boolean;
  refetch(): Promise<void>;
}
export type QueryField = "data" | "status" | "error" | "isPlaceholderData" | "isFetching" | "refetch";
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
/** 이 화면이 바로 전 렌더에 보이던 args 와 그 값(select 전 D) */
export type Prev<A, D> = { args: A; data: D };
/** 받은 값이 없을 때 보일 값 — 지어낸 값 그대로, 또는 함수(undefined 면 정하지 않았다) */
export type PlaceholderData<A, D> = D | ((args: A, prev: Prev<A, D>[]) => D | undefined);
/** 화면의 select 는 자원 select 의 결과(S)를 이어 받고, 자리 채우기는 select 전 모양 D 를 짓는다 */
type ScreenOptions<A, S, D> = {
  select?: (data: S, args: A) => unknown;
  placeholderData?: PlaceholderData<A, D>;
  /** 자원이 간격을 정하지 않은 args 를 채운다 — 보는 화면들 가운데 가장 짧은 간격 */
  refetchInterval?: RefetchInterval<A>;
};
/** 하나 꼴 — 조회 칸과 바꾸기 칸을 고른다 */
export type ResourceOptions<A, N extends string, S = unknown, D = unknown> = ScreenOptions<A, S, D> &
  ({ args?: A; pick?: readonly N[]; omit?: never } | { args?: A; omit?: readonly N[]; pick?: never });
/** 목록 꼴 — 조회 칸만 고른다. 바꾸기는 자원 전체에 하나라 항목에 넣지 않는다 */
export type ResourceListOptions<A, S = unknown, D = unknown> = ScreenOptions<A, S, D> &
  (
    | { args: readonly A[]; pick?: readonly QueryField[]; omit?: never }
    | { args: readonly A[]; omit?: readonly QueryField[]; pick?: never }
  );
// [O] 로 감싸 유니온에 나눠 걸지 않는다 — ReturnType 이 제약으로 읽으면 다 고른 하나 꼴이 된다
type Chosen<V, O> = [O] extends [{ pick: readonly (infer N)[] }]
  ? Pick<V, N & keyof V>
  : [O] extends [{ omit: readonly (infer N)[] }]
    ? Omit<V, N & keyof V>
    : V;
export type PickedView<D, R, O> = Chosen<ResourceView<D, R>, O>;
export type PickedQuery<D, O> = Chosen<QueryView<D>, O>;
// 아래 셋의 S 는 화면이 받는 data 의 모양이다 — 자원 select 를 거친 값. D 는 select 전 모양
export type ResourceUseOptions<A, S, R, D = S> =
  | ResourceOptions<A, ViewName<S, R>, S, D>
  | ResourceListOptions<A, S, D>
  | undefined;
/** 화면 select 가 있으면 그 결과가 data 다 */
type Selected<S, O> = [O] extends [{ select: (...a: any[]) => infer S2 }] ? S2 : S;
export type ResourceUseResult<S, R, O> = [O] extends [{ args: readonly unknown[] }]
  ? PickedQuery<Selected<S, O>, O>[]
  : PickedView<Selected<S, O>, R, O>;
/** 자원의 꺼내기 — 서명 하나다. 입력이 목록이면 배열을 돌려준다 */
export interface ResourceUse<A, S, R, D = S> {
  // O 에 기본값을 두지 않는다 — 있으면 TS 가 화면 select 의 인자 타입을 정하려고 O 를 그 기본값에 굳힌다
  <O extends ResourceUseOptions<A, S, R, D>>(options?: O): ResourceUseResult<S, R, O>;
}
/** store 끼리·시험이 보는 자원의 모양. 캐시는 서버 모양 D, 화면은 useStore 로 꺼내 select 를 거친 S 를 받는다 */
export type Resource<A, D, R, S = D> = Cache<A, D> & Mutations<R> & { [USE]: ResourceUse<A, S, R, D> };

type KeepPrevious = (<A, D>(args: A, prev: Prev<A, D>[]) => D | undefined) &
  (<A>(match: (args: A, prev: { args: A }) => boolean) => <D>(args: A, prev: Prev<A, D>[]) => D | undefined);
/**
 * 자리 채우기 도우미. `placeholderData: keepPreviousData` 는 하나 꼴에서 바로 전 값을, 목록 꼴에서 같은 args 의 앞 값만 잇는다.
 * `keepPreviousData(match)` 는 prev 가운데 match 가 참인 첫 항목의 값을 잇는다.
 */
export const keepPreviousData = ((...a: any[]) => {
  if (a.length === 1 && typeof a[0] === "function") {
    const match = a[0] as (args: unknown, prev: { args: unknown }) => boolean;
    return (args: unknown, prev: Prev<unknown, unknown>[]) => prev.find((p) => match(args, p))?.data;
  }
  // 목록 꼴인지는 훅이 셋째 인자로 알린다 — 목록이면 자리를 밀지 않고 같은 args 만 본다
  const [args, prev, list] = a as [unknown, Prev<unknown, unknown>[], boolean | undefined];
  const id = JSON.stringify(args ?? null);
  return list ? prev.find((p) => JSON.stringify(p.args ?? null) === id)?.data : prev[0]?.data;
}) as KeepPrevious;

const RESERVED = [...QUERY_FIELDS, "fetch", "getData", "setData", "invalidate"];

interface Cell<A, D> {
  args: A | undefined;
  view: { data: D | undefined; status: Status; error: string | null; isFetching: boolean };
  /** 요청 차례 — 이 차례가 아닌 응답은 버린다 */
  seq: number;
  inflight?: Promise<D>;
  /** 보지 않는 동안 무효화됐다 — 다시 볼 때 · fetch 할 때 받는다 */
  stale?: boolean;
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
 *
 * `select` 는 화면에 줄 때만 바꾼다 — 캐시(getData · setData · fetch)는 서버 모양 그대로다.
 */
export function createResource<A = void, D = never, R extends object = object, S = D>(
  define: (cache: Cache<A, D>) => R & { query?: (args: A) => Promise<D> },
  options: {
    auto?: boolean;
    select?: (data: D, args: A) => S;
    placeholderData?: PlaceholderData<A, D>;
    refetchInterval?: RefetchInterval<A>;
  } = {},
): Resource<A, D, R, S> {
  const auto = options.auto ?? true;
  const cells = new Map<string, Cell<A, D>>();
  const listeners = new Set<() => void>();
  const idOf = (args: A | undefined) => JSON.stringify(args ?? null);
  const refetcher = createRefetcher<A>({
    resource: options.refetchInterval,
    load: (args) => load(args),
    idOf,
    inflight: (args) => cells.get(idOf(args))?.inflight,
    // 낡은 칸을 다시 보면 받는다 — 그사이 fetch 가 받는 중이면 그것을 나눠 쓴다
    onWatch(args) {
      const cell = cells.get(idOf(args));
      if (!cell?.stale) return;
      cell.stale = false;
      if (cell.view.status !== "idle") load(args).catch(noop);
    },
  });
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
    cell.stale = false;
    // 받은 값이 있으면 status · error 는 그대로 두고 isFetching 만 켠다
    write(cell, cell.view.data === undefined ? { status: "loading", error: null, isFetching: true } : { isFetching: true });
    // 실행자는 곧바로 돈다 — query 가 동기로 던져도 거절로 바뀐다
    // 이 칸의 마지막 요청이 끝날 때만 주기에 알린다 — setData 로 응답을 버려도 끝은 알린다
    const end = (ok: boolean, view: Partial<Cell<A, D>["view"]>) => {
      const last = cell.inflight === request;
      if (last) cell.inflight = undefined;
      const next = { ...(cell.seq === seq ? view : {}), ...(last ? { isFetching: false } : {}) };
      if (Object.keys(next).length) write(cell, next);
      if (last) refetcher.settled(args as A, ok);
    };
    const request: Promise<D> = new Promise<D>((resolve) => resolve(query!.call(defined, args as A))).then(
      (data) => {
        end(true, { data, status: "ready", error: null });
        return data;
      },
      (e) => {
        end(false, { status: "error", error: message(e) });
        throw e;
      },
    );
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
  // 보는 칸만 곧바로 다시 받고, 보지 않는 칸은 낡음만 표시한다. 받는 중인 칸은 보지 않아도 다시 받는다 —
  // 무효화 앞에 떠난 응답을 뒤 fetch · 다시 보는 화면이 받지 않게. 그래서 낡은 칸에는 앞서 떠난 요청이 없다
  const reload = (cell: Cell<A, D>) => {
    if (cell.view.status === "idle") return;
    if (cell.inflight || refetcher.watching(cell.args as A)) return load(cell.args, true).catch(noop);
    cell.stale = true;
  };
  const fetchOne = (args: A | undefined) => {
    const cell = cellOf(args);
    // 받는 중이면 끝을 기다려 칸의 값을 준다 — invalidate 뒤 체인이 앞 값을 받지 않게. 그사이 setData 한 값이면 그것이다.
    // 기다리던 요청을 다른 요청이 밀어냈으면 그것을 다시 기다리고, 그사이 칸을 비웠으면 받은 응답을 준다
    const wait = (p: Promise<D>): Promise<D> =>
      p.then(
        (d) => (cell.inflight ? wait(cell.inflight) : cell.view.data === undefined ? d : (cell.view.data as D)),
        (e) => (cell.inflight ? wait(cell.inflight) : Promise.reject(e)),
      );
    if (cell.inflight) return wait(cell.inflight);
    return cell.view.status === "ready" && !cell.stale ? Promise.resolve(cell.view.data as D) : wait(load(args));
  };

  const cache = {
    getData: (args?: A | readonly A[]) => (Array.isArray(args) ? args.map(getOne) : getOne(args as A | undefined)),
    setData(updater: unknown, args?: A | readonly A[]) {
      if (Array.isArray(args)) args.forEach((a) => setOne(updater, a));
      else setOne(updater, args as A | undefined);
    },
    async invalidate(args?: A | readonly A[] | ((args: A) => boolean)) {
      // 함수 args 는 생성기가 막으므로 함수면 조건이다. idle 칸은 reload 가 건너뛰므로 조건도 부르지 않는다
      const targets =
        args === undefined
          ? [...cells.values()]
          : typeof args === "function"
            ? [...cells.values()].filter((c) => c.view.status !== "idle" && (args as (a: A) => boolean)(c.args as A))
            : (Array.isArray(args) ? args : [args]).map((a) => cellOf(a));
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

  const { select, placeholderData } = options;
  const { watch, rearm } = refetcher;
  const useResource = makeResourceHook({ cellOf, load, subscribe, idOf, query, auto, select, placeholderData, mutations, names, watch, rearm });
  return Object.assign(cache, mutations, { [USE]: useResource }) as unknown as Resource<A, D, R, S>;
}
