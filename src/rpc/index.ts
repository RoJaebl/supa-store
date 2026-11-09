// supa-store/rpc — 서버 앱이 띄운 프로세스나 다른 서버에 JSON-RPC 로 붙는다(session 은 내보내지 않는다)
export { createJsonRpc, type JsonRpc, type JsonRpcOptions } from "./client.js";
export { stdio, websocket, type StdioChild, type Transport } from "./transport.js";
export type { Framing } from "./framing.js";
export { RpcError } from "./error.js";
