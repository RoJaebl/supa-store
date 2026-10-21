/** Next 설정을 감싸 `next` 가 켜져 있으면 설정을 읽을 때 생성 파일을 쓴다. dev 서버에서는 정의 파일을 감시한다 */
export declare function withStore<T>(nextConfig: T): (phase: string) => T;
