/**
 * 客户简洁版开关：只影响前端展示，不删除功能代码。
 * true  = 面向客户：隐藏开发向入口与技术细节（seed / revision / 运行详情 / 工具轨迹 / 情境调整 / 回放等）；
 * false = 恢复完整界面，便于开发与验收。
 */
export const SIMPLE_UI = true;

/** 简洁版：去掉推荐理由中的 plan_id 与原始校验码，保留中文事实 */
export function clientReasonText(text: string): string {
  return text
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+_rev\d+\b[:：]?\s*/gi, "")
    .replace(/[（(][A-Z][A-Z0-9_]+[:：][^)）]*[)）]/g, "")
    .replace(/\bbalanced\b/g, "平衡目标")
    .replace(/\s{2,}/g, " ")
    .trim();
}
