// 자원 훅 — 정의 파일과 함께 서버 쪽에서도 평가되므로 "use client" 를 두지 않고 React 를 이름공간으로 가져온다
import * as React from "react";
import type { MutationView, Status } from "./query.js";

type Fn = (...args: any[]) => any;
type CellView<D> = { data: D | undefined; status: Status; error: string | null };

/** createResource 가 훅에 넘기는 안쪽 */
export interface ResourceCore<A, D> {
  cellOf(args: A | undefined): { view: CellView<D>; inflight?: Promise<D> };
  load(args: A | undefined, force?: boolean): Promise<D>;
  subscribe(listener: () => void): () => void;
  idOf(args: A | undefined): string;
  query: ((args: A) => Promise<D>) | undefined;
  auto: boolean;
  mutations: Record<string, Fn>;
  names: string[];
}

export const QUERY_FIELDS = ["data", "status", "error", "isPlaceholderData", "refetch"];
export const IDLE: CellView<never> = { data: undefined, status: "idle", error: null };
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const noop = () => {};
const subscribeNone = () => noop;

const plain = (x: unknown): x is object => {
  if (typeof x !== "object" || x === null) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};
/** 겉 한 겹 견주기 — 칸마다 Object.is, 둘 다 배열이거나 둘 다 보통 객체면 그 겉 칸도 Object.is. 깊이 견주지 않는다 */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Date · Map · 클래스 인스턴스는 Object.keys 가 값을 보이지 않으므로 Object.is 로만 본다
  if (!(Array.isArray(a) && Array.isArray(b)) && !(plain(a) && plain(b))) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && Object.is((a as any)[k], (b as any)[k]));
}

type Item = { on: boolean; out: Record<string, unknown> };
type Last = { core: object; fields: string; items: Record<string, unknown>[]; byId: Map<string, Item> };

export function makeResourceHook<A, D>(core: ResourceCore<A, D>): (options?: object) => unknown {
  const { cellOf, load, subscribe, idOf, query, auto, mutations, names } = core;

  return function useResource(options?: { args?: A | readonly A[]; pick?: readonly string[]; omit?: readonly string[] }) {
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
    const snapshot = () => {
      const prev = last.current?.core === core && last.current.fields === fields.join() ? last.current : null;
      const byId = new Map<string, Item>();
      const items = argsList.map((a, i) => {
        const id = ids[i]!;
        const on = active[i]!;
        const kept = byId.get(id);
        if (kept) return kept.out;
        const { data, status, error } = on ? cellOf(a).view : IDLE;
        const values: Record<string, unknown> = { data, status, error, isPlaceholderData: false };
        const before = prev?.byId.get(id);
        const reuse = before?.on === on && fields.every((f) => f === "refetch" || same(before.out[f], values[f]));
        let out = before?.out as Record<string, unknown>;
        if (!reuse) {
          values.refetch = () => (on ? load(a).then(noop, noop) : Promise.resolve());
          out = {};
          for (const f of fields) out[f] = values[f];
        }
        byId.set(id, { on, out });
        return out;
      });
      // 바뀐 항목이 없으면 앞 배열을 그대로 준다 — 다시 그리지 않는다
      if (prev && prev.items.length === items.length && items.every((it, i) => it === prev.items[i])) {
        prev.byId = byId;
        return prev.items;
      }
      last.current = { core, fields: fields.join(), items, byId };
      return items;
    };
    const items = React.useSyncExternalStore(active.some(Boolean) ? subscribe : subscribeNone, snapshot, snapshot);

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
        const moved = before !== null && !before.has(id);
        const cell = cellOf(a);
        if (cell.view.status === "ready" || (cell.inflight && !moved)) return;
        load(a, moved).catch(noop);
      });
      // 자원을 다시 지으면 core 가 새 객체다 — 새 칸은 idle 이므로 다시 받는다
    }, [activeKey, core]);

    // 바꾸기마다 훅을 정해진 차례로 부른다 — 꼴 · 고르기와 상관없이 훅 순서가 같다
    const views: Record<string, unknown> = {};
    for (const name of names) views[name] = useMutation(mutations[name]!);

    if (list) return items;
    const item = items[0]!;
    // 바꾸기 칸은 하나 꼴에서만 붙인다. ponytail: 바꾸기를 고르면 바꾸기 칸이 렌더마다 새 객체라 결과도 새 객체다
    if (!shown.some((n) => names.includes(n))) return item;
    const out: Record<string, unknown> = {};
    for (const name of shown) out[name] = name in item ? item[name] : views[name];
    return out;
  };
}

/** 바꾸기 하나의 화면별 상태. 화면 안에서 요청 차례를 세어 늦게 온 응답을 버린다 */
function useMutation(fn: Fn): MutationView<Fn> {
  const [state, setState] = React.useState<{ pending: boolean; error: string | null; data: unknown }>({
    pending: false,
    error: null,
    data: undefined,
  });
  const seq = React.useRef(0);
  // 밀린 호출은 칸을 건드리지 않지만 자기 Promise 는 자기 결과로 끝난다
  const run = async (args: unknown[]) => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, pending: true, error: null }));
    try {
      const data = await fn(...args);
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
      run(args).catch(noop);
    },
    mutateAsync: (...args) => run(args),
    reset() {
      seq.current += 1;
      setState({ pending: false, error: null, data: undefined });
    },
  };
}
