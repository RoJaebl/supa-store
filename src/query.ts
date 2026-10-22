// 정의 도우미 — 정의 파일은 서버 쪽에서도 평가되므로 "use client" 를 두지 않는다. 훅은 [USE] 안에서만 부른다
// 서버 층(react-server)의 react 에는 훅 이름이 없다 — 이름으로 가져오면 링크가 깨지므로 이름공간으로 가져온다
import * as React from "react";
import { USE } from "./index.js";

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

/** 자원 사이를 잇는 event. createStore("event.…", () => createEvent<P>()) 로 둔다 */
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
  getData(args?: A): D | undefined;
  /** 응답이 실어 온 값으로 바로 고친다 — 다시 받지 않는다 */
  setData(updater: D | ((prev: D | undefined) => D | undefined), args?: A): void;
  /** 다시 받는다 — args 를 주면 그 칸만, 없으면 받아 둔 칸 모두. 실패는 칸의 error 에 둔다 */
  invalidate(args?: A): Promise<void>;
  /** 받아서 칸에 넣고 값을 돌려준다 — 이미 받은 칸이면 그 값을 바로 준다(체인에서 쓴다). 실패하면 던진다 */
  fetch(args?: A): Promise<D>;
}

export type Status = "idle" | "loading" | "ready" | "error";
export interface QueryView<D> {
  data: D | undefined;
  status: Status;
  error: string | null;
  refetch(): Promise<void>;
}
export interface MutationView<F extends Fn> {
  /** 실패해도 던지지 않는다 — error 에 문구를 두고 undefined 를 준다 */
  mutate(...args: Parameters<F>): Promise<Awaited<ReturnType<F>> | undefined>;
  pending: boolean;
  error: string | null;
  data: Awaited<ReturnType<F>> | undefined;
  reset(): void;
}
/** 정의한 객체에서 query 를 뺀 함수 칸 — 바꾸기 */
export type Mutations<R> = { [K in keyof R as K extends "query" ? never : R[K] extends Fn ? K : never]: R[K] };
export type ResourceView<D, R> = QueryView<D> & { [K in keyof Mutations<R>]: MutationView<Mutations<R>[K] & Fn> };
type ViewName<D, R> = keyof ResourceView<D, R> & string;
export type ResourceOptions<A, N extends string> =
  | { args?: A; pick?: readonly N[]; omit?: never }
  | { args?: A; omit?: readonly N[]; pick?: never };
/** store 끼리·시험이 보는 자원의 모양. 화면은 useStore 로 꺼내 ResourceView 를 받는다 */
export type Resource<A, D, R> = Cache<A, D> &
  Mutations<R> & { [USE]: (options?: ResourceOptions<A, ViewName<D, R>>) => ResourceView<D, R> };

const QUERY_FIELDS = ["data", "status", "error", "refetch"];
const RESERVED = [...QUERY_FIELDS, "fetch", "getData", "setData", "invalidate"];

interface Cell<A, D> {
  args: A | undefined;
  view: { data: D | undefined; status: Status; error: string | null };
  /** 요청 차례 — 이 차례가 아닌 응답은 버린다 */
  seq: number;
  inflight?: Promise<D>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const noop = () => {};
const IDLE = { data: undefined, status: "idle" as Status, error: null };
const subscribeNone = () => noop;

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

  const cache: Cache<A, D> = {
    getData: (args) => cells.get(idOf(args))?.view.data,
    setData(updater, args) {
      const cell = cellOf(args);
      const data =
        typeof updater === "function" ? (updater as (prev: D | undefined) => D | undefined)(cell.view.data) : updater;
      // 차례를 올려 이 앞에 떠난 조회의 늦은 응답이 고친 값을 덮지 못하게 한다
      cell.seq += 1;
      // 값을 비우면(받은 적 없는 목록으로 되돌리기) 처음으로 돌린다 — 버린 응답 탓에 loading 에 갇히지 않고 다음에 다시 받는다
      write(cell, { data, status: data === undefined ? "idle" : "ready", error: null });
    },
    async invalidate(args) {
      const targets = args === undefined ? [...cells.values()] : [cellOf(args)];
      await Promise.all(targets.filter((c) => c.view.status !== "idle").map((c) => load(c.args, true).catch(noop)));
    },
    fetch: (args) => {
      const cell = cellOf(args);
      return cell.view.status === "ready" ? Promise.resolve(cell.view.data as D) : load(args);
    },
  };

  const defined = define(cache) as Record<string, unknown>;
  const query = defined.query as ((args: A) => Promise<D>) | undefined;
  const mutations: Record<string, Fn> = {};
  for (const [name, value] of Object.entries(defined)) {
    if (name === "query" || typeof value !== "function") continue;
    if (RESERVED.includes(name)) throw new Error(`바꾸기 이름으로 쓸 수 없다: ${name}`);
    mutations[name] = (value as Fn).bind(defined);
  }
  const names = Object.keys(mutations);

  function useResource(opts?: { args?: A; pick?: readonly string[]; omit?: readonly string[] }) {
    const args = opts?.args;
    const shown = opts?.pick ?? [...QUERY_FIELDS, ...names].filter((n) => !opts?.omit?.includes(n));
    // 조회 칸을 하나도 고르지 않았거나, 인자가 필요한데 없으면 조회를 시작하지도 구독하지도 않는다
    const active =
      query !== undefined && shown.some((n) => QUERY_FIELDS.includes(n)) && !(query.length > 0 && args === undefined);
    const id = idOf(args);
    const snapshot = () => (active ? cellOf(args).view : IDLE);
    const view = React.useSyncExternalStore(active ? subscribe : subscribeNone, snapshot, snapshot);

    const seen = React.useRef<string | null>(null);
    React.useEffect(() => {
      if (!active || !auto) return;
      // 이 화면이 다른 칸에서 넘어왔으면(A→B→A) 진행 중인 앞 요청을 나눠 쓰지 않고 새로 받는다
      const moved = seen.current !== null && seen.current !== id;
      seen.current = id;
      const cell = cellOf(args);
      if (cell.view.status === "ready" || (cell.inflight && !moved)) return;
      load(args, moved).catch(noop);
    }, [active, id]);

    const out: Record<string, unknown> = {
      ...view,
      refetch: () => (active ? load(args).then(noop, noop) : Promise.resolve()),
    };
    // 바꾸기마다 훅을 정해진 차례로 부른다 — 고르기와 상관없이 훅 순서가 같다
    for (const name of names) out[name] = useMutation(mutations[name]!);
    const picked: Record<string, unknown> = {};
    for (const name of shown) picked[name] = out[name];
    return picked;
  }

  return Object.assign(cache, mutations, { [USE]: useResource }) as unknown as Resource<A, D, R>;
}

/** 바꾸기 하나의 화면별 상태. 화면 안에서 요청 차례를 세어 늦게 온 응답을 버린다 */
function useMutation(fn: Fn): MutationView<Fn> {
  const [state, setState] = React.useState<{ pending: boolean; error: string | null; data: unknown }>({
    pending: false,
    error: null,
    data: undefined,
  });
  const seq = React.useRef(0);
  return {
    ...state,
    async mutate(...args) {
      const mine = ++seq.current;
      setState((s) => ({ ...s, pending: true, error: null }));
      try {
        const data = await fn(...args);
        if (mine === seq.current) setState({ pending: false, error: null, data });
        return data;
      } catch (e) {
        if (mine === seq.current) setState((s) => ({ ...s, pending: false, error: message(e) }));
        return undefined;
      }
    },
    reset() {
      seq.current += 1;
      setState({ pending: false, error: null, data: undefined });
    },
  };
}
