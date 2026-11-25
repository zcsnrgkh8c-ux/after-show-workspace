/**
 * 请求序号守卫：同类操作只接受最新一次请求的响应。
 * 延迟到达或乱序的旧响应必须被丢弃，不得覆盖新状态（联调加固要求1）。
 */
const seqByKind = new Map<string, number>();

/** 发起请求时取号 */
export function beginRequest(kind: string): number {
  const next = (seqByKind.get(kind) ?? 0) + 1;
  seqByKind.set(kind, next);
  return next;
}

/** 响应到达时验号：非最新序号 = 旧响应，调用方必须丢弃 */
export function isLatest(kind: string, id: number): boolean {
  return seqByKind.get(kind) === id;
}

/** 测试用：重置全部计数 */
export function resetRequestGate(): void {
  seqByKind.clear();
}
