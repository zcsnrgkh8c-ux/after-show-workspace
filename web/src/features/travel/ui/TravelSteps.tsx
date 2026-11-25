/**
 * 出行步骤指示 + 当前步骤主操作（受控展示，无自身副作用）：
 * - 步骤：确认起点 → 选择终点 → 规划路线 → 查看结果；
 * - 同一时刻只有一个主操作，标签由父级按当前步骤提供；
 * - 步骤 chip 仅指示，不触发请求（避免误触重新规划）。
 */
import type { TravelStepKey } from "./display";

const STEPS: Array<{ key: TravelStepKey; label: string; hint: string }> = [
  { key: "origin", label: "起点", hint: "定位或手选" },
  { key: "destination", label: "终点", hint: "搜索并点选" },
  { key: "plan", label: "规划", hint: "高德步行路线" },
  { key: "result", label: "结果", hint: "路线事实与建议" },
];

export interface TravelPrimaryAction {
  label: string;
  onClick: () => void;
  /** 处理中（如规划中）：按钮禁用并显示 busyLabel */
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  /** 主操作下方说明（禁用原因 / 下一步提示） */
  hint?: string | null;
}

export interface TravelStepsProps {
  step: TravelStepKey;
  action: TravelPrimaryAction;
  secondary?: { label: string; onClick: () => void } | null;
  /** 出行方式：仅影响步骤提示文案，不改变流程 */
  mode?: "walking" | "transit";
}

export function TravelSteps({ step, action, secondary, mode = "walking" }: TravelStepsProps) {
  const steps =
    mode === "walking"
      ? STEPS
      : STEPS.map((s) =>
          s.key === "plan"
            ? { ...s, hint: "高德公交/地铁" }
            : s.key === "result"
              ? { ...s, hint: "路线事实（无建议）" }
              : s
        );
  const currentIndex = steps.findIndex((s) => s.key === step);
  return (
    <section className="travel-card travel-steps-card" aria-label="出行步骤">
      <ol className="travel-steps">
        {steps.map((s, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "todo";
          return (
            <li
              key={s.key}
              className={`travel-step travel-step--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="travel-step-index" aria-hidden="true">
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="travel-step-text">
                <span className="travel-step-label">{s.label}</span>
                <span className="travel-step-hint">{s.hint}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="travel-primary-row">
        <button
          type="button"
          className="travel-primary-btn"
          onClick={action.onClick}
          disabled={action.disabled || action.busy}
          aria-busy={action.busy ? true : undefined}
        >
          {action.busy ? (action.busyLabel ?? `${action.label}…`) : action.label}
        </button>
        {secondary !== null && secondary !== undefined && (
          <button type="button" className="travel-secondary-btn" onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
      </div>
      {action.hint !== null && action.hint !== undefined && action.hint !== "" && (
        <p className="travel-action-hint" role="note">
          {action.hint}
        </p>
      )}
    </section>
  );
}
