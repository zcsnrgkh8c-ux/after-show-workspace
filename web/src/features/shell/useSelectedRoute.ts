/**
 * selectedRouteId 展示状态（窗口4/App 专用）：
 * 仅表示“用户当前点开查看的路线”，不写入 Scenario/Plan、不触发任何业务请求。
 * 归属校验：路线必须仍存在于当前查看（实时/回放）场景，且仍属于
 * 当前查看方案中当前组的分配；场景/轮次/实时回放/方案/组变化时自动清除，
 * 避免旧路线在地图上继续突出。
 */
import { useEffect, useState } from "react";
import { useApp, useViewingBundle } from "../../state/store";

export interface SelectedRouteState {
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string | null) => void;
}

export function useSelectedRoute(): SelectedRouteState {
  const { state } = useApp();
  const { inReplay, bundle, scenarioForView } = useViewingBundle();
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedRouteId === null) return;
    const plan = bundle?.plans.find((p) => p.plan_id === state.selectedPlanId) ?? null;
    const alloc =
      plan && state.selectedGroupId
        ? plan.allocations.find((a) => a.group_id === state.selectedGroupId)
        : null;
    const inPlanAlloc = !!alloc?.routes.some((r) => r.route_id === selectedRouteId);
    const inScenario = scenarioForView.routes.some((r) => r.route_id === selectedRouteId);
    if (!inPlanAlloc || !inScenario) setSelectedRouteId(null);
  }, [selectedRouteId, bundle, state.selectedPlanId, state.selectedGroupId, scenarioForView, inReplay]);

  return { selectedRouteId, onSelectRoute: setSelectedRouteId };
}
