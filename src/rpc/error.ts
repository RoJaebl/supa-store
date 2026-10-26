// 요청 하나의 실패 — 0.3 의 CommandError 처럼 message 가 문구다
export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    message: string,
    public requestId: number,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
  }
}
