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

type Definition = (set: SetState<any>, get: GetState<any>) => object;
interface Entry {
  api: StoreApi<any>;
  reset(next?: Definition): void;
}

// 번들러(Next·Vite)가 process.env.NODE_ENV 를 글자로 바꾼다. Node 타입을 들이지 않으려고 모양만 선언한다
declare const process: { env: { NODE_ENV?: string } };

const registry =new Map<string, Entry>();

function build(definition: Definition): Entry {
  let state: any;
  let initial: any;
  let current = definition;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const getState = () => state;
  const setState: SetState<any> = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    if (Object.is(next, state)) return;
    state = Object.assign({}, state, next);
    notify();
  };
  const reset = (next?: Definition) => {
    if (next) current = next;
    state = initial = current(setState, getState);
    notify();
  };

  state = initial = definition(setState, getState);
  const api: StoreApi<any> = {
    getState,
    getInitialState: () => initial,
    setState,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { api, reset };
}

/** key 로 등록하고 곧 짓는다. set·get 의 타입은 생성된 StateTypes 에서 온다 */
export function createStore<K extends string>(
  key: K,
  definition: (set: SetState<StateOf<K>>, get: GetState<StateOf<K>>) => object,
): void {
  const existing = registry.get(key);
  if (!existing) {
    registry.set(key, build(definition as Definition));
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`같은 key 를 두 번 등록했다: ${key}`);
  }
  existing.reset(definition as Definition);
}

/** 등록된 상태 하나 — 등록되지 않은 key 면 `등록되지 않은 key 다: <key>` 로 실패한다 */
export function getStore<K extends StateKey>(key: K): StoreApi<StateOf<K>> {
  const entry = registry.get(key);
  if (!entry) throw new Error(`등록되지 않은 key 다: ${key}`);
  return entry.api;
}

/** 모든 상태를 처음 값으로 되돌린다. 구독자는 남기고 알린다 — 시험 사이에 부른다 */
export function resetStores(): void {
  registry.forEach((entry) => entry.reset());
}

/** 등록된 key 전부, 정렬해서 — 출력 스냅숏이 쓴다 */
export function registeredKeys(): string[] {
  return [...registry.keys()].sort();
}
