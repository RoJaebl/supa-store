// 자원 훅 — 정의 파일과 함께 서버 쪽에서도 평가되므로 "use client" 를 두지 않고 React 를 이름공간으로 가져온다
import * as React from "react";
import type { MutationView, PlaceholderData, Prev, Status } from "./query.js";
import { type MutationChannel, type MutationFn, message } from "./mutation.js";
import { type RefetchInterval, valueOf } from "./refetch.js";

export { message };

type Fn = (...args: any[]) => any;
type CellView<D> = { data: D | undefined; status: Status; error: string | null; isFetching: boolean };

/** createResource 가 훅에 넘기는 안쪽 */
export interface ResourceCore<A, D> {
  /** stale 은 보지 않는 동안 무효화된 칸 — 화면이 보기 시작하면 곧바로 다시 받는다 */
  cellOf(args: A | undefined): { view: CellView<D>; request?: Promise<D>; stale?: boolean };
  load(args: A | undefined, force?: boolean): Promise<D>;
  subscribe(listener: () => void): () => void;
  idOf(args: A | undefined): string;
  query: ((args: A) => Promise<D>) | undefined;
  auto: boolean;
  /** 자원의 select — 화면에 줄 때만 거친다 */
  select: ((data: D, args: A) => unknown) | undefined;
  /** 자원의 자리 채우기 — 화면의 것보다 먼저 구한다 */
  placeholderData: PlaceholderData<A, D> | undefined;
  /** 바꾸기마다 자원이 쥔 상태 — call 은 부를 수 있는 바꾸기, channel 은 그 구독 단위 */
  mutations: Record<string, { call: MutationFn<Fn>; channel: MutationChannel }>;
  names: string[];
  /** 화면이 args 를 보기 시작한다(주기 받기) — 풀기 함수를 돌려준다 */
  watch(args: A | undefined, screen: RefetchInterval<A | undefined>): () => void;
  /** 화면 간격이 바뀌었다 — 그 args 의 타이머를 지금 값으로 다시 건다 */
  rearm(args: A | undefined): void;
}

export const QUERY_FIELDS = ["data", "status", "error", "isPlaceholderData", "isFetching", "refetch"];
export const IDLE: CellView<never> = { data: undefined, status: "idle", error: null, isFetching: false };
export const noop = () => {};
export const subscribeNone = () => noop;

const plain = (x: unknown): x is object => {
  if (typeof x !== "object" || x === null) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};
/** 겉 한 겹 견주기 — 칸마다 Object.is, 둘 다 배열이거나 둘 다 보통 객체면 그 겉 칸도 Object.is. 깊이 견주지 않는다 */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Date · Map · 클래스 인스턴스는 Object.keys 가 값을 보이지 않으므로 Object.is 로만 본다
  if (!(Array.isArray(a) && Array.isArray(b)) && !(plain(a) && plain(b))) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && Object.is((a as any)[k], (b as any)[k]));
}

/**
 * raw 는 보인 값(받은 값 또는 자리를 채운 값)의 select 전 D, screen 은 그때 쓴 화면 select, data 는 거친 결과.
 * filled 는 자리를 채웠을 때 그때 쓴 화면 placeholderData 를 담는다 — 받은 값이면 undefined
 */
type Item = {
  on: boolean;
  out: Record<string, unknown>;
  raw: unknown;
  screen: Fn | undefined;
  data: unknown;
  filled: { with: unknown } | undefined;
};
type Last = {
  core: object;
  fields: string;
  items: Record<string, unknown>[];
  byId: Map<string, Item>;
  /** 이 스냅숏이 보인 값 — 그려진 뒤 다음 렌더의 prev 가 된다 */
  visible: Prev<unknown, unknown>[];
};

/** 자원 → 화면 차례로 구한다. 함수의 셋째 인자는 keepPreviousData 꼴 1 에 목록 꼴인지 알린다 */
function fill(sources: unknown[], args: unknown, prev: Prev<unknown, unknown>[], list: boolean): unknown {
  for (const p of sources) {
    const v = typeof p === "function" ? p(args, prev, list) : p;
    if (v !== undefined) return v;
  }
  return undefined;
}

export function makeResourceHook<A, D>(core: ResourceCore<A, D>): (options?: object) => unknown {
  const { cellOf, load, subscribe, idOf, query, auto, select, placeholderData, mutations, names, watch, rearm } = core;
  type Options = {
    args?: A | readonly A[];
    pick?: readonly string[];
    omit?: readonly string[];
    select?: Fn;
    placeholderData?: unknown;
    refetchInterval?: RefetchInterval<A | undefined>;
  };

  return function useResource(options?: Options) {
    // 하나 꼴은 길이 1 목록처럼 다루고 마지막에 푼다 — 두 꼴이 같은 훅을 같은 차례로 부른다
    const list = Array.isArray(options?.args);
    const argsList = (list ? options!.args : [options?.args]) as (A | undefined)[];
    const shown =
      options?.pick ?? [...QUERY_FIELDS, ...(list ? [] : names)].filter((n) => !options?.omit?.includes(n));
    const fields = shown.filter((n) => QUERY_FIELDS.includes(n));
    // 조회 칸을 하나도 고르지 않았거나, 인자가 필요한데 없으면 그 항목은 받지도 구독하지도 않는다
    const active = argsList.map((a) => query !== undefined && fields.length > 0 && !(query.length > 0 && a === undefined));
    const ids = argsList.map(idOf);
    // 렌더마다 새 args 배열이어도 칸 id 를 이은 글자가 같으면 같은 것으로 본다
    const activeKey = ids.filter((_, i) => active[i]).join("\n");

    const last = React.useRef<Last | null>(null);
    // 바로 전 렌더에 보이던 값 — 고른 칸이 바뀌어도 last 와 달리 버리지 않는다
    const prevShown = React.useRef<Prev<unknown, unknown>[]>([]);
    const snapshot = () => {
      const prev = last.current?.core === core && last.current.fields === fields.join() ? last.current : null;
      const byId = new Map<string, Item>();
      const items = argsList.map((a, i) => {
        const id = ids[i]!;
        const on = active[i]!;
        const kept = byId.get(id);
        if (kept) return kept.out;
        const cell = on ? cellOf(a) : undefined;
        const { data: got, status, error } = cell?.view ?? IDLE;
        // 낡은 칸은 이 화면이 보기 시작하면(watch 효과) 다시 받는다 — 첫 판부터 받는 중으로 보인다. 칸의 값은 건드리지 않는다
        const isFetching = cell ? cell.view.isFetching || (cell.stale === true && status !== "idle") : false;
        const before = prev?.byId.get(id);
        const screen = options?.select;
        // 받는 항목이 받은 값이 없으면(받는 중 · 실패) 자리를 채운다. 앞에도 채웠고 화면 placeholderData 가 그대로면 그 값을 쓴다 —
        // 그려진 뒤 prev 가 바뀌어도 다시 구하지 않아야 새 객체를 짓는 함수가 끝없이 다시 그리지 않는다
        let raw: unknown = got;
        let filled: Item["filled"];
        if (got === undefined && on) {
          filled = { with: options?.placeholderData };
          raw =
            before?.filled && before.raw !== undefined && before.filled.with === filled.with
              ? before.raw
              : fill([placeholderData, filled.with], a, list ? prevShown.current : prevShown.current.slice(0, 1), list);
        }
        // 자원 select → 화면 select. getSnapshot 은 렌더마다 여러 번 불리므로 받은 값과 화면 select 가 그대로면 앞 결과를 쓴다 —
        // 안 그러면 매번 새 객체를 만드는 select 가 스냅숏을 흔들어 끝없이 다시 그린다. 자원 select 는 core 와 함께 같다
        let data: unknown = raw;
        if (before && Object.is(before.raw, raw) && before.screen === screen) data = before.data;
        else {
          if (data !== undefined && select) data = select(data as D, a as A);
          if (data !== undefined && screen) data = screen(data, a);
        }
        const values: Record<string, unknown> = {
          data,
          status,
          error,
          isPlaceholderData: filled !== undefined && raw !== undefined,
          isFetching,
        };
        const reuse = before?.on === on && fields.every((f) => f === "refetch" || same(before.out[f], values[f]));
        let out = before?.out as Record<string, unknown>;
        if (!reuse) {
          values.refetch = () => (on ? load(a).then(noop, noop) : Promise.resolve());
          out = {};
          for (const f of fields) out[f] = values[f];
        }
        byId.set(id, { on, out, raw, screen, data, filled });
        return out;
      });
      const visible = argsList.flatMap((a, i) => {
        const raw = byId.get(ids[i]!)!.raw;
        return raw === undefined ? [] : [{ args: a, data: raw }];
      });
      // 바뀐 항목이 없으면 앞 배열을 그대로 준다 — 다시 그리지 않는다
      if (prev && prev.items.length === items.length && items.every((it, i) => it === prev.items[i])) {
        prev.byId = byId;
        prev.visible = visible;
        return prev.items;
      }
      last.current = { core, fields: fields.join(), items, byId, visible };
      return items;
    };
    const items = React.useSyncExternalStore(active.some(Boolean) ? subscribe : subscribeNone, snapshot, snapshot);
    // 화면 간격은 렌더마다 새 함수여도 된다 — 타이머가 걸릴 때 마지막 값을 읽는다
    const interval = React.useRef(options?.refetchInterval);
    // 그려진 뒤에야 prev 를 넘긴다 — 한 렌더 안에서 스냅숏이 여러 번 불려도 모두 같은 앞 렌더를 본다
    React.useEffect(() => {
      prevShown.current = last.current?.visible ?? [];
      interval.current = options?.refetchInterval;
    });

    const seen = React.useRef<Set<string> | null>(null);
    React.useEffect(() => {
      if (!activeKey || !auto) return;
      // 이 화면이 다른 칸에서 넘어왔으면(A→B→A) 진행 중인 앞 요청을 나눠 쓰지 않고 새로 받는다
      const before = seen.current;
      seen.current = new Set(activeKey.split("\n"));
      const done = new Set<string>();
      argsList.forEach((a, i) => {
        const id = ids[i]!;
        if (!active[i] || done.has(id)) return;
        done.add(id);
        // 하나 꼴의 args 가 바뀐 것만 넘어온 것이다 — 목록에 새로 든 args 는 남이 받는 중인 요청을 나눠 쓴다
        const moved = !list && before !== null && !before.has(id);
        const cell = cellOf(a);
        if (cell.view.status === "ready" || (cell.request && !moved)) return;
        load(a, moved).catch(noop);
      });
      // 자원을 다시 지으면 core 가 새 객체다 — 새 칸은 idle 이므로 다시 받는다
    }, [activeKey, core]);

    // 주기 받기에 보는 args 를 건다. auto 와 상관없다. 앞과 견주어 빠진 것만 풀고 새 것만 건다 — 그대로인 args 의 타이머는 이어 간다
    const watching = React.useRef(new Map<string, () => void>());
    React.useEffect(() => {
      const want = new Map<string, A | undefined>();
      argsList.forEach((a, i) => active[i] && want.set(ids[i]!, a));
      const map = watching.current;
      map.forEach((stop, id) => want.has(id) || (stop(), map.delete(id)));
      const screen = (a: A | undefined) => valueOf(interval.current, a);
      want.forEach((a, id) => map.has(id) || map.set(id, watch(a, screen)));
    }, [activeKey, core]);
    // 떠나거나 자원을 다시 지으면 모두 푼다 — 정리가 위 효과보다 먼저 돌므로 다시 지을 때 비운 map 에 새 자원으로 다시 건다
    React.useEffect(() => {
      const map = watching.current;
      return () => {
        map.forEach((stop) => stop());
        map.clear();
      };
    }, [core]);
    // args 는 그대로이고 화면 간격만 바뀌면 다시 건다 — 위 효과는 args 가 바뀔 때만 돈다
    const intervalKey = argsList.map((a, i) => (active[i] ? `${ids[i]}=${valueOf(options?.refetchInterval, a)}` : "")).join("\n");
    const armed = React.useRef(intervalKey);
    React.useEffect(() => {
      if (armed.current === intervalKey) return;
      armed.current = intervalKey;
      argsList.forEach((a, i) => active[i] && rearm(a));
    }, [intervalKey]);

    // 바꾸기마다 훅을 정해진 차례로 부른다 — 꼴 · 고르기와 상관없이 훅 순서가 같다
    const views: Record<string, unknown> = {};
    for (const name of names) views[name] = useMutation(mutations[name]!.call);

    if (list) return items;
    const item = items[0]!;
    // 바꾸기 칸은 하나 꼴에서만 붙인다. ponytail: 바꾸기를 고르면 바꾸기 칸이 렌더마다 새 객체라 결과도 새 객체다
    if (!shown.some((n) => names.includes(n))) return item;
    const out: Record<string, unknown> = {};
    for (const name of shown) out[name] = name in item ? item[name] : views[name];
    return out;
  };
}

/**
 * 바꾸기 하나의 화면별 상태. 화면 안에서 요청 차례를 세어 늦게 온 응답을 버린다.
 * more 는 같은 차례 세기로 다른 부르기를 돌리는 칸을 더한다(연결 명령의 retry)
 */
export function useMutation(
  fn: Fn,
  more?: (run: (call: () => unknown) => Promise<unknown>) => object,
): MutationView<Fn> {
  const [state, setState] = React.useState<{ pending: boolean; error: string | null; data: unknown }>({
    pending: false,
    error: null,
    data: undefined,
  });
  const seq = React.useRef(0);
  // 밀린 호출은 칸을 건드리지 않지만 자기 Promise 는 자기 결과로 끝난다
  const run = async (call: () => unknown) => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, pending: true, error: null }));
    try {
      const data = await call();
      if (mine === seq.current) setState({ pending: false, error: null, data });
      return data;
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ ...s, pending: false, error: message(e) }));
      throw e;
    }
  };
  return {
    ...state,
    mutate(...args) {
      run(() => fn(...args)).catch(noop);
    },
    mutateAsync: (...args) => run(() => fn(...args)),
    reset() {
      seq.current += 1;
      setState({ pending: false, error: null, data: undefined });
    },
    ...more?.(run),
  };
}
