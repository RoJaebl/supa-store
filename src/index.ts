export type SetState<T> = (partial: Partial<T> | ((now: T) => Partial<T>)) => void;
export type GetState<T> = () => T;

export interface StoreApi<T> {
  getState(): T;
  getInitialState(): T;
  setState: SetState<T>;
  subscribe(listener: () => void): () => void;
}

/** key → 상태 타입. 생성 파일이 글자로 덧붙인다. 사람이 쓰지 않는다 */
export interface StateTypes {}

// 생성 파일이 없으면 key 가 never 다 — 검사가 조용히 꺼지지 않고 모든 호출이 실패한다
export type StateKey = keyof StateTypes & string;
export type StateOf<K> = K extends StateKey ? StateTypes[K] : unknown;

/** 한 store 상태의 칸 이름 */
export type Names<K> = keyof StateOf<K> & string;
/** 고를 칸(pick) 또는 뺄 칸(omit) — 둘 중 하나만 */
export type PickOptions<K, N extends Names<K> = Names<K>> =
  | { pick: readonly N[]; omit?: never }
  | { omit: readonly N[]; pick?: never };
/** 고른 결과의 타입 — pick 이면 그 칸만, omit 이면 그 칸을 뺀 나머지 */
export type Picked<K, O> = O extends { pick: readonly (infer N)[] }
  ? Pick<StateOf<K>, N & keyof StateOf<K>>
  : O extends { omit: readonly (infer N)[] }
    ? Omit<StateOf<K>, N & keyof StateOf<K>>
    : StateOf<K>;

/** creator 의 셋째 인자 — 다른 store 의 부르는 순간의 값을 꺼낸다. 구독은 없다 */
export interface Ctx {
  <K extends StateKey>(key: K): StateOf<K>;
  <K extends StateKey, N extends Names<K>, O extends PickOptions<K, N>>(key: K, options: O): Picked<K, O>;
  /** 지금 짓고 있는 store 의 key — event 에 「누가」를 남길 때 쓴다 */
  readonly key: string;
}

type Creator = (set: SetState<any>, get: GetState<any>, ctx: Ctx) => object;
type PickFromOptions = { pick?: readonly string[]; omit?: readonly string[] };

interface Entry {
  key: string;
  definition: Creator;
  override?: Creator;
  built: boolean;
  /** 마지막으로 지을 때 ctx 로 꺼낸 key */
  deps: Set<string>;
  listeners: Set<() => void>;
  api: StoreApi<any>;
  build(): void;
}

// 번들러(Next·Vite)가 process.env.NODE_ENV 를 글자로 바꾼다. Node 타입을 들이지 않으려고 모양만 선언한다
declare const process: { env: { NODE_ENV?: string } };

const registry = new Map<string, Entry>();
/** 지금 짓고 있는 key 의 사슬 — 같은 key 가 다시 나오면 순환이다 */
const building: string[] = [];

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

function entryOf(key: string): Entry {
  const entry = registry.get(key);
  if (!entry) throw new Error(`등록되지 않은 key 다: ${key}`);
  return entry;
}

function ensure(entry: Entry): Entry {
  if (!entry.built) entry.build();
  return entry;
}

function makeEntry(key: string, definition: Creator): Entry {
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
  const ctx = Object.assign(
    (other: string, options?: PickFromOptions) => {
      // 짓는 동안 꺼낸 key 만 기록한다. 동작 안에서 부를 때 꺼낸 것은 기댐이 아니다
      if (building[building.length - 1] === key) entry.deps.add(other);
      return pickFrom(ensure(entryOf(other)).api.getState(), options);
    },
    { key },
  ) as Ctx;

  const entry: Entry = {
    key,
    definition,
    built: false,
    deps: new Set(),
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
    build() {
      if (building.includes(key)) throw new Error(`순환한다: ${[...building, key].join(" → ")}`);
      building.push(key);
      try {
        entry.deps.clear();
        state = initial = (entry.override ?? entry.definition)(setState, get, ctx);
        entry.built = true;
      } finally {
        building.pop();
      }
    },
  };
  return entry;
}

/**
 * 주어진 key 와, 지을 때 그것을 꺼낸 store 를 (거슬러 올라가며) 모두 무른다.
 * 무르기 전에 지어져 있던 것은 곧 다시 짓고(듣기가 새 store 에 다시 걸린다), 구독자가 있으면 알린다
 */
function rebuild(keys: Iterable<string>): void {
  const stale = new Set<Entry>();
  const mark = (entry: Entry) => {
    if (stale.has(entry)) return;
    stale.add(entry);
    registry.forEach((other) => other.deps.has(entry.key) && mark(other));
  };
  for (const key of keys) mark(entryOf(key));
  const again = [...stale].filter((entry) => entry.built);
  stale.forEach((entry) => (entry.built = false));
  again.forEach(ensure);
  again.forEach((entry) => entry.listeners.forEach((l) => l()));
}

/** key 로 등록한다. 짓는 것은 처음 꺼낼 때다. set·get 의 타입은 생성된 StateTypes 에서 온다 */
export function createStore<K extends string>(
  key: K,
  creator: (set: SetState<StateOf<K>>, get: GetState<StateOf<K>>, ctx: Ctx) => object,
): void {
  const existing = registry.get(key);
  if (!existing) {
    registry.set(key, makeEntry(key, creator as Creator));
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`같은 key 를 두 번 등록했다: ${key}`);
  }
  // 개발 모드 재등록(Fast Refresh)은 정의를 바꿔 끼운다 — resetStores 가 되돌리지 않는다
  existing.definition = creator as Creator;
  rebuild([key]);
}

/** 처음 등록한 정의 대신 이것으로 짓는다. 그 key 에 기대던 store 도 다시 짓는다 */
export function overrideStore<K extends StateKey>(
  key: K,
  creator: (set: SetState<StateOf<K>>, get: GetState<StateOf<K>>, ctx: Ctx) => object,
): void {
  entryOf(key).override = creator as Creator;
  rebuild([key]);
}

/** 등록된 상태 하나 — 등록되지 않은 key 면 `등록되지 않은 key 다: <key>` 로 실패한다. 다시 지어도 같은 객체다 */
export function getStore<K extends StateKey>(key: K): StoreApi<StateOf<K>> {
  return entryOf(key).api;
}

/** 덮어쓴 정의를 모두 지우고, 전부 무른 뒤 지어져 있던 것을 다시 지어 알린다. 구독자는 남는다 — 시험 사이에 부른다 */
export function resetStores(): void {
  registry.forEach((entry) => (entry.override = undefined));
  rebuild(registry.keys());
}

/** 등록된 key 전부, 정렬해서 — 출력 스냅숏이 쓴다 */
export function registeredKeys(): string[] {
  return [...registry.keys()].sort();
}
