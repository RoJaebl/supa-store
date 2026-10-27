// 주기적으로 다시 받기 — 자원 하나에 하나. args 하나에 타이머 하나이고, 그 args 를 보는 화면이 있는 동안만 돈다
// 정의 파일과 함께 서버 쪽에서도 평가되므로 "use client" 를 두지 않는다. 타이머는 화면의 effect 에서만 걸린다

/** 주기 간격(ms). 함수면 args 마다 구한다 — false · undefined 는 정하지 않았다 */
export type RefetchInterval<A> = number | false | ((args: A) => number | false | undefined);

/** 실패할 때마다 두 배, 기본 간격의 8배까지 */
const MAX_LEVEL = 3;

interface Watched<A> {
  args: A;
  screens: Array<RefetchInterval<A> | undefined>;
  /** 간격을 세기 시작한 때 — 받기가 끝난 때, 또는 타이머를 처음 건 때 */
  from: number;
  timer?: ReturnType<typeof setTimeout>;
  /** 가려진 동안 간격이 지났다 — 보이면 곧바로 받는다 */
  due: boolean;
}

/** 함수가 던지면 그 args 는 간격을 정하지 않은 것으로 본다 — 받기가 끝난 자리에서 불려 성공을 거절로 바꾸지 않게 */
export const valueOf = <A>(v: RefetchInterval<A> | undefined, args: A) => {
  try {
    return typeof v === "function" ? v(args) : v;
  } catch {
    return undefined;
  }
};
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export function createRefetcher<A>(core: {
  resource: RefetchInterval<A> | undefined;
  load(args: A): Promise<unknown>;
  idOf(args: A): string;
  inflight(args: A): Promise<unknown> | undefined;
  /** 그 args 를 보는 첫 화면이 들어왔다 */
  onWatch?(args: A): void;
  /** 그 args 를 보던 마지막 화면이 빠졌다 */
  onUnwatch?(args: A): void;
}) {
  const watched = new Map<string, Watched<A>>();
  /** 늘린 정도 — args 마다, 보는 화면이 없어도 쥔다. 0 이면 지운다 */
  const levels = new Map<string, number>();

  /** 자원 값이 숫자면 그것, 아니면 보는 화면들 가운데 가장 짧은 숫자 */
  const baseOf = (w: Watched<A>): number | undefined => {
    const own = valueOf(core.resource, w.args);
    if (typeof own === "number") return own;
    const nums = w.screens.map((s) => valueOf(s, w.args)).filter((v): v is number => typeof v === "number");
    return nums.length ? Math.min(...nums) : undefined;
  };

  const poll = (id: string) => {
    const w = watched.get(id);
    if (!w) return;
    w.timer = undefined;
    if (hidden()) w.due = true;
    // 끝나면 load 가 settled 를 불러 다시 건다
    else core.load(w.args).catch(() => {});
  };

  /** 지금 값으로 타이머를 다시 건다. 받는 중이면 끝날 때 settled 가 건다 */
  const arm = (id: string, w: Watched<A>) => {
    clearTimeout(w.timer);
    w.timer = undefined;
    const base = baseOf(w);
    if (base === undefined || w.due || core.inflight(w.args)) return;
    const delay = base * 2 ** (levels.get(id) ?? 0);
    w.timer = setTimeout(() => poll(id), Math.max(0, w.from + delay - Date.now()));
  };

  const onVisible = () => {
    if (hidden()) return;
    watched.forEach((w, id) => {
      if (!w.due) return;
      w.due = false;
      poll(id);
    });
  };

  return {
    /** 화면이 args 를 보기 시작한다 — 풀기 함수를 돌려준다. 마지막 화면이 떠나면 타이머를 걷는다 */
    watch(args: A, screen: RefetchInterval<A> | undefined): () => void {
      const id = core.idOf(args);
      let w = watched.get(id);
      const first = !w;
      if (!w) {
        if (watched.size === 0 && typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
        watched.set(id, (w = { args, screens: [], from: Date.now(), due: false }));
      }
      const entry = w;
      // 같은 값이 둘이면 풀 때 어느 것을 지워도 같다
      entry.screens.push(screen);
      arm(id, entry);
      if (first) core.onWatch?.(args);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        entry.screens.splice(entry.screens.indexOf(screen), 1);
        if (entry.screens.length > 0) return arm(id, entry);
        clearTimeout(entry.timer);
        watched.delete(id);
        if (watched.size === 0 && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
        core.onUnwatch?.(entry.args);
      };
    },
    /** 그 args 를 보는 화면이 있는가 */
    watching: (args: A): boolean => watched.has(core.idOf(args)),
    /** 화면 간격이 바뀌었다 — 세던 때(from)는 그대로 두고 지금 값으로 다시 건다. 없으면 타이머만 걷힌다 */
    rearm(args: A): void {
      const id = core.idOf(args);
      const w = watched.get(id);
      if (w) arm(id, w);
    },
    /** 그 args 의 받기가 끝났다(어디서 받았든) — 늘린 정도를 고치고 끝난 때부터 다시 센다 */
    settled(args: A, ok: boolean): void {
      const id = core.idOf(args);
      const level = ok ? 0 : Math.min((levels.get(id) ?? 0) + 1, MAX_LEVEL);
      if (level) levels.set(id, level);
      else levels.delete(id);
      const w = watched.get(id);
      if (!w) return;
      w.from = Date.now();
      w.due = false;
      arm(id, w);
    },
  };
}
