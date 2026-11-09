/** 개발 모드에서 정의 파일(`createStore` 를 가져오는 파일)이 HMR 갱신을 받지 않게 해, 고치면 페이지를 통째로 다시 읽는다. 함수형 설정도 받는다 */
export declare function withStore<T>(nextConfig: T): (phase: string, ctx?: unknown) => T extends (...args: never[]) => infer R ? R : T;
