/** 错误分类：http=服务返回错误码；timeout=超时；network=断网/不可达；bad_response=响应格式/校验失败 */
export type ApiErrorKind = "http" | "timeout" | "network" | "bad_response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly httpStatus?: number;
  readonly detail?: string;

  constructor(kind: ApiErrorKind, message: string, opts?: { httpStatus?: number; detail?: string }) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.httpStatus = opts?.httpStatus;
    this.detail = opts?.detail;
  }
}
