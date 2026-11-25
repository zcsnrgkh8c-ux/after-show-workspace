/**
 * 建议响应的请求身份比对（纯函数，可单测）。
 * 服务端契约回显 request_id / candidate_set_id；客户端必须核对二者与本次请求一致，
 * 只校验“选了哪条路线、路线是否在候选内”不足以识别错配响应（例如同结构但不同请求的响应）。
 */
export interface AdviceIdentity {
  request_id: string;
  candidate_set_id: string;
}

/** 响应身份是否与本次请求一致（两者都必须相等且非空） */
export function matchesAdviceIdentity(resp: AdviceIdentity, req: AdviceIdentity): boolean {
  if (typeof resp.request_id !== "string" || resp.request_id === "") return false;
  if (typeof resp.candidate_set_id !== "string" || resp.candidate_set_id === "") return false;
  return resp.request_id === req.request_id && resp.candidate_set_id === req.candidate_set_id;
}
