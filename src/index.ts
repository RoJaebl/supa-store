import { labelFromStack } from "./label.js";
import { resetScopes } from "./mutation.js";
import { DERIVED, noteRead, type Channel } from "./track.js";
export { DERIVED };

/** 상태에 이 표식으로 함수를 두면 useStore 가 꺼내기를 그 함수에 맡긴다 — 그 함수는 훅이다 */
export const USE: unique symbol = Symbol.for("supa-store.use") as never;
/** 상태 객체에 `[DISPOSE]: () => void` 가 있으면 그 store 를 다시 짓기 직전과 disposeStores 에서 부른다 */
export const DISPOSE: unique symbol = Symbol.for("supa-store.dispose") as never;

export type SetState<T> = (partial: Partial<T> | ((now: T) => Partial<T>)) => void;
export type GetState<T> = () => T;

export interface StoreApi<T> {
  getState(): T;
  getInitialState(): T;
  setState: SetState<T>;
  subscribe(listener: () => void): () => void;
}

declare const STATE: unique symbol;
/** createStore 가 돌려주는 핸들 — store 를 가리키는 표지일 뿐이다. 읽고 쓰는 길은 getStore(handle) 이다 */
export interface Store<S> {
  readonly [STATE]?: S;
}

/** 한 store 상태의 칸 이름 */
export type Names<S> = keyof S & string;
/** 고를 칸(pick) 또는 뺄 칸(omit) — 둘 중 하나만 */
export type PickOptions<S, N extends Names<S> = Names<S>> =
  | { pick: readonly N[]; omit?: never }
  | { omit: readonly N[]; pick?: never };
/** 고른 결과의 타입 — pick 이면 그 칸만, omit 이면 그 칸을 뺀 나머지 */
export type Picked<S, O> = O extends { pick: readonly (infer N)[] }
  ? Pick<S, N & keyof S>
  : O extends { omit: readonly (infer N)[] }
    ? Omit<S, N & keyof S>
    : S;

/** 파생 store 의 상태 — createDerived(supa-store/query)가 짓는다. useStore · ctx 로 꺼내면 값 T 를 준다 */
export interface Derived<T> {
  /** 지금 값. 구독자가 없으면 그 자리에서 계산한다(읽은 것이 그대로면 앞 결과) */
  get(): T;
  subscribe(listener: () => void): () => void;
  [USE](): T;
  [DISPOSE](): void;
  [DERIVED]: Channel;
}
/** ctx 로 읽었을 때의 값 — 파생이면 그 값, 아니면 상태 그대로 */
export type ReadOf<S> = S extends Derived<infer T> ? T : S;

/** creator 의 셋째 인자 — 다른 store 의 부르는 순간의 값을 꺼낸다. 인자 없이 부르면 자기 자신. 계산 공간(select · createDerived) 안에서 읽으면 그 store 를 따라간다 */
export interface Ctx<Self = unknown> {
  /** 인자 없이 부르면 자기 상태를 준다. 짓는 동안에는 쓸 수 없고, 짓기 기록에도 적지 않는다 */
  (): Self;
  <T>(store: Store<T>): ReadOf<T>;
  <T, N extends Names<T>, O extends PickOptions<T, N>>(store: Store<T>, options: O): Picked<T, O>;
}

/** store 를 짓는 함수 — 핸들을 받는 API 가 모두 이 꼴을 받는다 */
type CreatorOf<S> = (set: SetState<S>, get: GetState<S>, ctx: Ctx<S>) => S;
type Creator = (set: SetState<any>, get: GetState<any>, ctx: Ctx<any>) => object;
type PickFromOptions = { pick?: readonly string[]; omit?: readonly string[] };

interface Entry {
  /** 오류 문구에 찍는 이름 — 부른 자리 `<경로>:<줄>` 이거나 등록 차례 `#<n>` */
  label: string;
  handle: Store<unknown>;
  definition: Creator;
  override?: Creator;
  built: boolean;
  /** 마지막으로 지을 때 ctx 로 꺼낸 store */
  deps: Set<Entry>;
  /** 짓는 동안 adopt 로 맡은 정리 함수 — dispose 때 [DISPOSE] 뒤에 부르고 비운다 */
  offs: (() => void)[];
  listeners: Set<() => void>;
  api: StoreApi<any>;
  /** 계산 공간이 이 store 를 읽었을 때 적는 채널 — 상태 객체가 바뀌면 달라진다 */
  channel: Channel;
  build(): void;
  /** 지어져 있으면 앞 상태의 [DISPOSE] 를 부르고 맡은 정리 함수를 부른다. 던져도 삼킨다 — 다시 짓기를 막지 않는다 */
  dispose(): void;
}

// 번들러(Next·Vite)가 process.env.NODE_ENV 를 글자로 바꾼다. Node 타입을 들이지 않으려고 모양만 선언한다
declare const process: { env: { NODE_ENV?: string } };

/** 등록한 차례대로 */
const entries: Entry[] = [];
/** 핸들에서 entry 로 가는 길 — 라이브러리 안에만 둔다 */
const entryOfHandle = new WeakMap<object, Entry>();
/** 지금 짓고 있는 store 의 사슬 — 같은 store 가 다시 나오면 순환이다 */
const building: Entry[] = [];

/** 고른 칸만 담은 새 객체. 함수 칸은 원래 상태 객체를 this 로 묶는다 — 메서드 꼴 정의가 this 를 써도 된다 */
export function pickFrom(state: object, options?: PickFromOptions): object {
  if (!options?.pick && !options?.omit) return state;
  const source = state as Record<string, unknown>;
  const omit = options.omit ?? [];
  const names = options.pick ?? Object.keys(source).filter((name) => !omit.includes(name));
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const value = source[name];
    out[name] = typeof value === "function" ? value.bind(state) : value;
  }
  return out;
}

function entryOf(store: Store<unknown>): Entry {
  const entry = typeof store === "object" && store !== null ? entryOfHandle.get(store) : undefined;
  if (!entry) throw new Error("store 핸들이 아니다");
  return entry;
}

/** 맡은 정리 함수를 모두 부르고 비운다. 하나가 던져도 나머지를 부르고 밖으로 새지 않는다 */
function runOffs(entry: Entry): void {
  for (const off of entry.offs.splice(0)) {
    try {
      off();
    } catch (error) {
      console.error(`맡은 정리 함수가 던졌다: ${entry.label}`, error);
    }
  }
}

function ensure(entry: Entry): Entry {
  if (!entry.built) entry.build();
  return entry;
}

function makeEntry(label: string, definition: Creator): Entry {
  let state: any;
  let initial: any;
  const listeners = new Set<() => void>();

  const get = () => state;
  const setState: SetState<any> = (partial) => {
    ensure(entry);
    const next = typeof partial === "function" ? partial(state) : partial;
    if (Object.is(next, state)) return;
    state = Object.assign({}, state, next);
    listeners.forEach((l) => l());
  };
  const ctx = (
    (...args: [other?: Store<unknown>, options?: PickFromOptions]) => {
      const [other, options] = args;
      if (other === undefined) {
        if (building[building.length - 1] === entry) throw new Error(`짓는 동안에는 자기 자신을 꺼낼 수 없다: ${label}`);
        return entry.api.getState();
      }
      const target = entryOf(other);
      // 짓는 동안 꺼낸 store 만 기록한다. 동작 안에서 부를 때 꺼낸 것은 기댐이 아니다
      if (building[building.length - 1] === entry) entry.deps.add(target);
      ensure(target);
      // 계산 공간(track) 안이면 읽었다고 적는다 — 어느 store 의 ctx 로 읽었는지는 가리지 않는다
      noteRead(target.channel);
      const state = target.api.getState();
      // 파생은 상태가 아니라 값을 준다 — 그 값의 채널도 적어 파생이 파생을 따라간다
      if (state && typeof state === "object" && DERIVED in state) {
        noteRead((state as Derived<unknown>)[DERIVED]);
        return (state as Derived<unknown>).get();
      }
      return pickFrom(state, options);
    }
  ) as Ctx;

  const entry: Entry = {
    label,
    handle: Object.freeze({}),
    definition,
    built: false,
    deps: new Set(),
    offs: [],
    listeners,
    api: {
      getState: () => (ensure(entry), state),
      getInitialState: () => (ensure(entry), initial),
      setState,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    channel: {
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      snapshot: () => (ensure(entry), state),
    },
    dispose() {
      if (!entry.built) return;
      try {
        state?.[DISPOSE]?.();
      } catch (error) {
        console.error(`[DISPOSE] 가 던졌다: ${label}`, error);
      }
      runOffs(entry);
    },
    build() {
      if (building.includes(entry)) throw new Error(`순환한다: ${[...building, entry].map((e) => e.label).join(" → ")}`);
      building.push(entry);
      try {
        entry.deps.clear();
        state = initial = (entry.override ?? entry.definition)(setState, get, ctx);
        entry.built = true;
      } catch (error) {
        runOffs(entry);
        throw error;
      } finally {
        building.pop();
      }
    },
  };
  return entry;
}

/**
 * 주어진 store 와, 지을 때 그것을 꺼낸 store 를 (거슬러 올라가며) 모두 무른다.
 * 무르기 전에 지어져 있던 것은 곧 다시 짓고(듣기가 새 store 에 다시 걸린다), 구독자가 있으면 알린다
 */
function rebuild(targets: Iterable<Entry>): void {
  const stale = new Set<Entry>();
  const mark = (entry: Entry) => {
    if (stale.has(entry)) return;
    stale.add(entry);
    entries.forEach((other) => other.deps.has(entry) && mark(other));
  };
  for (const entry of targets) mark(entry);
  const again = [...stale].filter((entry) => entry.built);
  again.forEach((entry) => entry.dispose());
  stale.forEach((entry) => (entry.built = false));
  again.forEach(ensure);
  again.forEach((entry) => entry.listeners.forEach((l) => l()));
}

/**
 * store 를 등록하고 그것을 가리키는 핸들을 돌려준다. 짓는 것은 처음 꺼낼 때다.
 * 부를 때마다 새 store 다 — 모듈 최상단에서만 부른다. set·get 의 타입은 creator 의 반환 타입에서 온다.
 * 인자를 받는 creator 는 타입 인자를 적는다 — 빠뜨리면 상태가 never 로 굳어 컴파일 오류가 난다
 */
export function createStore<S extends object = never>(creator: CreatorOf<S>): Store<S> {
  // stack 은 이 모듈 안에서 만든다 — labelFromStack 이 이 파일의 프레임을 건너뛰고 부른 자리를 읽는다
  const label =
    (process.env.NODE_ENV === "production" ? null : labelFromStack(new Error().stack)) ?? `#${entries.length + 1}`;
  const entry = makeEntry(label, creator as Creator);
  entries.push(entry);
  entryOfHandle.set(entry.handle, entry);
  return entry.handle as Store<S>;
}

export namespace createStore {
  /**
   * `ctx` 만 쓰는 정의 — set · get 을 받지 않으므로 상태 타입이 돌려주는 값에서 추론된다.
   * 동작은 `createStore((_set, _get, ctx) => creator(ctx))` 와 같다. `ctx()` 는 자기 타입을 모르므로 `unknown` 이다 —
   * 자기 자신은 자기 핸들로 읽는다. 모듈 최상단에서만 부른다
   */
  export function ofContext<S extends object>(creator: (ctx: Ctx) => S): Store<S> {
    // 이 파일 안에서 createStore 를 부르므로 이름은 이 프레임까지 건너뛰고 ofContext 를 부른 자리를 읽는다
    return createStore<S>((_set, _get, ctx) => creator(ctx as Ctx));
  }
}

/** 처음 등록한 정의 대신 이것으로 짓는다. 그 store 에 기대던 store 도 다시 짓는다. 시험의 가짜는 일부 칸만 돌려줘도 된다 */
export function overrideStore<S>(
  store: Store<S>,
  creator: (set: SetState<S>, get: GetState<S>, ctx: Ctx<S>) => object,
): void {
  const entry = entryOf(store);
  entry.override = creator as Creator;
  rebuild([entry]);
}

/** 핸들이 가리키는 store — 핸들이 아니면 `store 핸들이 아니다` 로 실패한다. 다시 지어도 같은 객체다 */
export function getStore<S>(store: Store<S>): StoreApi<S> {
  return entryOf(store).api;
}

/** 덮어쓴 정의를 모두 지우고, 전부 무른 뒤 지어져 있던 것을 다시 지어 알린다. 구독자는 남는다 — 시험 사이에 부른다 */
export function resetStores(): void {
  entries.forEach((entry) => (entry.override = undefined));
  rebuild(entries);
  resetScopes();
}

/** 지어진 모든 store 의 [DISPOSE] 를 부르고 지어지지 않은 상태로 되돌린다. 다시 짓지 않는다(다음에 꺼낼 때 짓는다) — 구독자는 남는다 */
export function disposeStores(): void {
  entries.forEach((entry) => {
    entry.dispose();
    entry.built = false;
  });
}

/** 등록한 store 전부, 등록한 차례대로 — 앱 전체에 거는 일(다시 이어졌을 때 모든 자원을 낡게 하기 같은)에 쓴다 */
export function registeredStores(): Store<unknown>[] {
  return entries.map((entry) => entry.handle);
}

/**
 * @internal — 지금 짓고 있는 store. adopt 로 맡긴 함수는 그 store 를 dispose 할 때 [DISPOSE] 뒤에 돈다(query.ts 의 event 가 쓴다).
 * store 를 가리는 것은 handle 이다 — label 은 한 도우미 함수 안에서 지은 store 끼리 겹치므로 문구와 기록에만 쓴다
 */
export function currentBuild(): { label: string; handle: Store<unknown>; adopt(off: () => void): void } | undefined {
  const entry = building[building.length - 1];
  return entry && { label: entry.label, handle: entry.handle, adopt: (off) => void entry.offs.push(off) };
}
