import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type {
  Mode,
  Objective,
  ParseResponse,
  Plan,
  Recommendation,
  Scenario,
  SimulationResult,
  TraceEntry,
} from "../contract/types";
import { DEFAULT_SEED, cloneDefaultScenario } from "../contract/defaultScenario";
import { api, ApiError, setClientLogger, type ClientLogEvent } from "../api/client";
import { beginRequest, isLatest } from "../api/requestGate";
import { SCHEMA_VERSION } from "../contract/types";
import {
  applyPatchToScenario,
  canApplyPending,
  reconcileSelection,
  runMatchesCurrent,
  scenarioIdentity,
  type PatchApplyResult,
  type ViewSelection,
} from "./scenarioOps";
import { loadPersistedReplays, persistReplays } from "./replayStorage";

// 纯函数经此再导出，保持既有引用路径不变
export { applyPatchToScenario, patchOldValue, runMatchesCurrent, scenarioIdentity } from "./scenarioOps";
export type { PatchApplyResult } from "./scenarioOps";

/* ================= 状态定义 ================= */

export interface ClientLogEntry extends ClientLogEvent {
  id: number;
  at: number;
}

/** 一轮“生成+比较”的完整产物，全部绑定 scenario_id/revision/seed/objective */
export interface RunBundle {
  scenario_id: string;
  scenario_revision: number;
  seed: number;
  objective: Objective;
  plans: Plan[];
  generate_trace: TraceEntry[];
  generate_mode: Mode;
  results: SimulationResult[];
  recommendation: Recommendation | null;
  compare_trace: TraceEntry[];
  compare_mode: Mode;
  finished_at: number;
}

export interface SavedReplay {
  replay_id: string;
  saved_at: number;
  label: string;
  scenario: Scenario;
  bundle: RunBundle;
}

/** 待确认的 NL patch：绑定解析时的场景身份，旧 patch 不得应用到新场景 */
export interface NlPending {
  instruction: string;
  response: ParseResponse;
  scenario_id: string;
  base_revision: number;
}

export interface UiError {
  id: number;
  area: string;
  message: string;
  detail?: string;
}

export interface HealthState {
  state: "checking" | "ok" | "down";
  engine_ready?: boolean;
  llm_configured?: boolean;
  schema_version?: string;
  message?: string;
}

export type Viewing = { kind: "live" } | { kind: "replay"; replay: SavedReplay };

export interface AppState {
  health: HealthState;
  scenario: Scenario;
  seed: number;
  objective: Objective;
  run: RunBundle | null;
  viewing: Viewing;
  replays: SavedReplay[];
  nl: { pending: NlPending | null; busy: boolean; error: string | null };
  busyGenerate: boolean;
  busySimulatePlanId: string | null;
  errors: UiError[];
  clientLog: ClientLogEntry[];
  selectedPlanId: string | null;
  selectedGroupId: string | null;
  /** 进入回放前保存的实时视图选择；退出回放时校正恢复后清空（回放间切换不覆盖） */
  liveSelection: ViewSelection | null;
  playT: number;
  playing: boolean;
}

/* ================= Reducer ================= */

type Action =
  | { type: "health"; payload: HealthState }
  | { type: "setObjective"; objective: Objective }
  | { type: "setSeed"; seed: number }
  | { type: "scenarioApplied"; scenario: Scenario }
  | { type: "nlStart" }
  | { type: "nlPending"; pending: NlPending }
  | { type: "nlError"; message: string }
  | { type: "nlClear" }
  | { type: "generateStart" }
  | { type: "generateDone"; bundle: RunBundle }
  | { type: "generateFail"; message: string; detail?: string }
  | { type: "simulatePlanStart"; planId: string }
  | { type: "simulatePlanDone"; result: SimulationResult }
  | { type: "simulatePlanFail"; planId: string; message: string; detail?: string }
  | { type: "pushError"; error: UiError }
  | { type: "dismissError"; id: number }
  | { type: "log"; entry: ClientLogEntry }
  | { type: "selectPlan"; planId: string | null }
  | { type: "selectGroup"; groupId: string | null }
  | { type: "setPlayT"; t: number }
  | { type: "setPlaying"; playing: boolean }
  | { type: "saveReplay"; replay: SavedReplay }
  | { type: "loadReplay"; replayId: string }
  | { type: "exitReplay" };

let idCounter = 1;

const initialState: AppState = {
  health: { state: "checking" },
  scenario: cloneDefaultScenario(),
  seed: DEFAULT_SEED,
  objective: "balanced",
  run: null,
  viewing: { kind: "live" },
  replays: loadPersistedReplays(),
  nl: { pending: null, busy: false, error: null },
  busyGenerate: false,
  busySimulatePlanId: null,
  errors: [],
  clientLog: [],
  selectedPlanId: null,
  selectedGroupId: null,
  liveSelection: null,
  playT: 0,
  playing: false,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "health":
      return { ...state, health: action.payload };
    case "setObjective":
      return { ...state, objective: action.objective, selectedPlanId: null, playT: 0, playing: false };
    case "setSeed":
      return { ...state, seed: action.seed };
    case "scenarioApplied":
      // 场景确认变更：revision 已 +1；旧 run 由 runMatchesCurrent 判定过期；
      // 待确认的 NL patch 属于旧场景，一并作废（旧 patch 不得应用到新场景）
      return {
        ...state,
        scenario: action.scenario,
        nl: { pending: null, busy: false, error: null },
        selectedPlanId: null,
        playT: 0,
        playing: false,
        viewing: state.viewing.kind === "replay" ? state.viewing : { kind: "live" },
      };
    case "nlStart":
      return { ...state, nl: { pending: null, busy: true, error: null } };
    case "nlPending":
      return { ...state, nl: { pending: action.pending, busy: false, error: null } };
    case "nlError":
      return { ...state, nl: { pending: null, busy: false, error: action.message } };
    case "nlClear":
      return { ...state, nl: { pending: null, busy: false, error: null } };
    case "generateStart":
      return { ...state, busyGenerate: true };
    case "generateDone":
      return {
        ...state,
        busyGenerate: false,
        run: action.bundle,
        selectedPlanId: action.bundle.recommendation?.plan_id ?? action.bundle.plans[0]?.plan_id ?? null,
        playT: 0,
        playing: false,
      };
    case "generateFail":
      return {
        ...state,
        busyGenerate: false,
        errors: [
          ...state.errors,
          { id: idCounter++, area: "生成/比较", message: action.message, detail: action.detail },
        ],
      };
    case "simulatePlanStart":
      return { ...state, busySimulatePlanId: action.planId };
    case "simulatePlanDone": {
      const { result } = action;
      const run = state.run;
      if (!run) return { ...state, busySimulatePlanId: null };
      const idx = run.results.findIndex((r) => r.plan_id === result.plan_id);
      const results = idx >= 0 ? run.results.map((r, i) => (i === idx ? result : r)) : [...run.results, result];
      return { ...state, busySimulatePlanId: null, run: { ...run, results } };
    }
    case "simulatePlanFail":
      return {
        ...state,
        busySimulatePlanId: null,
        errors: [
          ...state.errors,
          { id: idCounter++, area: `单方案推演(${action.planId})`, message: action.message, detail: action.detail },
        ],
      };
    case "pushError":
      return { ...state, errors: [...state.errors, action.error] };
    case "dismissError":
      return { ...state, errors: state.errors.filter((e) => e.id !== action.id) };
    case "log":
      return { ...state, clientLog: [...state.clientLog.slice(-199), action.entry] };
    case "selectPlan":
      return { ...state, selectedPlanId: action.planId, playT: 0, playing: false };
    case "selectGroup":
      return { ...state, selectedGroupId: action.groupId };
    case "setPlayT":
      return { ...state, playT: action.t };
    case "setPlaying":
      return { ...state, playing: action.playing };
    case "saveReplay":
      return { ...state, replays: [...state.replays, action.replay] };
    case "loadReplay": {
      const replay = state.replays.find((r) => r.replay_id === action.replayId);
      if (!replay) return state;
      // 进入回放：仅在从实时视角进入时保存当前实时选择；回放之间切换不覆盖最初保存的上下文
      const liveSelection =
        state.viewing.kind === "live"
          ? { planId: state.selectedPlanId, groupId: state.selectedGroupId }
          : state.liveSelection;
      // 回放自身的方案/组选择须属于该回放快照：组非 null 但不存在于回放场景时同样回退
      const sel = reconcileSelection(
        { planId: replay.bundle.recommendation?.plan_id ?? null, groupId: state.selectedGroupId },
        replay.bundle.plans,
        replay.bundle.recommendation?.plan_id ?? null,
        replay.scenario.groups
      );
      return {
        ...state,
        viewing: { kind: "replay", replay },
        liveSelection,
        selectedPlanId: sel.planId,
        selectedGroupId: sel.groupId,
        playT: 0,
        playing: false,
      };
    }
    case "exitReplay": {
      // 退出回放：恢复进入前保存的实时选择，并按当前实时 bundle/scenario 校正归属；
      // 已失效则回退到当前合法推荐/候选与有效组；run 为空才呈现真实空状态。
      // live 结果已过期时仍恢复该选择，由展示层“情况已变化”守卫呈现，不把旧推荐冒充为有效。
      const sel = reconcileSelection(
        state.liveSelection ?? { planId: null, groupId: state.selectedGroupId },
        state.run?.plans ?? [],
        state.run?.recommendation?.plan_id ?? null,
        state.scenario.groups
      );
      return {
        ...state,
        viewing: { kind: "live" },
        liveSelection: null,
        selectedPlanId: sel.planId,
        selectedGroupId: sel.groupId,
        playT: 0,
        playing: false,
      };
    }
    default:
      return state;
  }
}

/* ================= Context & Actions ================= */

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    setClientLogger((e) => dispatch({ type: "log", entry: { ...e, id: idCounter++, at: Date.now() } }));
    return () => setClientLogger(null);
  }, []);

  // 回放持久化：刷新或服务不可达后仍可查看已标记的缓存回放
  useEffect(() => {
    persistReplays(state.replays);
  }, [state.replays]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp 必须在 AppProvider 内使用");
  return ctx;
}

function staleDropMsg(kind: string, expected: string, actual: string): string {
  return `${kind}响应到达时场景已变化（${expected} → ${actual}），已丢弃该次旧响应，未覆盖当前状态`;
}

/** 业务动作：全部走真实 API；请求带序号与身份守卫，旧响应/错身份响应一律丢弃并显式提示 */
export function useActions() {
  const { state, dispatch } = useApp();
  const stateRef = useRef(state);
  stateRef.current = state;

  const checkHealth = useCallback(async () => {
    const reqId = beginRequest("health");
    dispatch({ type: "health", payload: { state: "checking" } });
    try {
      const h = await api.health();
      if (!isLatest("health", reqId)) return; // 旧 health 响应不得覆盖新状态
      if (h.schema_version !== SCHEMA_VERSION) {
        dispatch({
          type: "health",
          payload: {
            state: "down",
            schema_version: h.schema_version,
            message: `契约版本不匹配：服务端 ${h.schema_version}，前端要求 ${SCHEMA_VERSION}。请同步 A/B 后再联调`,
          },
        });
        return;
      }
      dispatch({
        type: "health",
        payload: {
          state: "ok",
          engine_ready: h.engine_ready,
          llm_configured: h.llm_configured,
          schema_version: h.schema_version,
        },
      });
    } catch (err) {
      if (!isLatest("health", reqId)) return;
      const e = err as ApiError;
      dispatch({ type: "health", payload: { state: "down", message: e.detail ? `${e.message}：${e.detail}` : e.message } });
    }
  }, [dispatch]);

  const parseInstruction = useCallback(
    async (instruction: string) => {
      const s = stateRef.current;
      const reqId = beginRequest("parse");
      const reqIdentity = scenarioIdentity(s.scenario);
      const baseRevision = s.scenario.revision;
      dispatch({ type: "nlStart" });
      try {
        const resp = await api.parseScenario({ scenario: s.scenario, instruction });
        if (!isLatest("parse", reqId)) return; // 已有更新的解析请求
        if (scenarioIdentity(stateRef.current.scenario) !== reqIdentity) {
          dispatch({ type: "nlError", message: staleDropMsg("解析", reqIdentity, scenarioIdentity(stateRef.current.scenario)) });
          return;
        }
        dispatch({
          type: "nlPending",
          pending: { instruction, response: resp, scenario_id: s.scenario.scenario_id, base_revision: baseRevision },
        });
      } catch (err) {
        if (!isLatest("parse", reqId)) return;
        const e = err as ApiError;
        dispatch({ type: "nlError", message: e.detail ? `${e.message}：${e.detail}` : e.message });
      }
    },
    [dispatch]
  );

  /** 用户点击“确认应用”：patch 必须仍绑定当前场景，确认后才应用且 revision+1 */
  const applyPendingPatch = useCallback((): PatchApplyResult | null => {
    const s = stateRef.current;
    const pending = s.nl.pending;
    if (!pending) return null;
    if (!canApplyPending(pending, s.scenario)) {
      dispatch({
        type: "pushError",
        error: {
          id: idCounter++,
          area: "自然语言变更",
          message: `该 patch 对应旧场景（${pending.scenario_id}@rev${pending.base_revision}，当前 rev${s.scenario.revision}），已作废，请重新解析`,
        },
      });
      dispatch({ type: "nlClear" });
      return null;
    }
    const result = applyPatchToScenario(s.scenario, pending.response.patch);
    dispatch({ type: "scenarioApplied", scenario: result.next });
    dispatch({ type: "nlClear" });
    return result;
  }, [dispatch]);

  const discardPendingPatch = useCallback(() => {
    dispatch({ type: "nlClear" });
  }, [dispatch]);

  /** 手动编辑保存：传入已校验的新场景草稿（不含 revision），此处 +1 */
  const applyManualScenario = useCallback(
    (draft: Scenario) => {
      const s = stateRef.current;
      dispatch({ type: "scenarioApplied", scenario: { ...draft, revision: s.scenario.revision + 1 } });
    },
    [dispatch]
  );

  /** 重置为默认场景（恢复车辆等）；同样 revision+1 并使旧结果过期 */
  const resetScenario = useCallback(() => {
    const s = stateRef.current;
    const fresh = cloneDefaultScenario();
    fresh.revision = s.scenario.revision + 1;
    dispatch({ type: "scenarioApplied", scenario: fresh });
  }, [dispatch]);

  /** 主流程：plan/generate → compare（同一 objective）；序号+身份双重守卫 */
  const generateAndCompare = useCallback(async () => {
    const s = stateRef.current;
    const reqId = beginRequest("generate");
    const scenario = structuredClone(s.scenario);
    const reqIdentity = scenarioIdentity(scenario);
    const { objective, seed } = s;
    dispatch({ type: "generateStart" });

    const fail = (message: string, detail?: string) => dispatch({ type: "generateFail", message, detail });
    try {
      const gen = await api.generatePlans({ scenario, objective, seed });
      let results: SimulationResult[] = [];
      let recommendation: Recommendation | null = null;
      let compareTrace: typeof gen.trace = [];
      let compareMode: typeof gen.mode = gen.mode;
      if (gen.plans.length > 0) {
        const cmp = await api.compare({ scenario, plans: gen.plans, seed, objective });
        results = cmp.results;
        recommendation = cmp.recommendation;
        compareTrace = cmp.trace;
        compareMode = cmp.mode;
      }

      if (!isLatest("generate", reqId)) return; // 已有更新的生成请求，丢弃本次旧响应
      const cur = stateRef.current;
      if (scenarioIdentity(cur.scenario) !== reqIdentity || cur.objective !== objective || cur.seed !== seed) {
        fail(staleDropMsg("生成/比较", reqIdentity, `${scenarioIdentity(cur.scenario)}（目标/seed 可能亦已变化）`));
        return;
      }
      // 共享契约允许损坏输入下身份为 null；C 侧必须显式拒绝，不能当作可用结果
      if (
        results.some(
          (r) => r.scenario_id === null || r.scenario_revision === null || r.plan_id === null || r.seed === null
        )
      ) {
        fail("返回结果缺少完整身份字段（scenario_id / scenario_revision / plan_id / seed），已丢弃");
        return;
      }
      // 逐项核对返回身份：错身份结果绝不展示
      for (const p of gen.plans) {
        if (p.scenario_id !== scenario.scenario_id || p.scenario_revision !== scenario.revision) {
          fail(`返回方案身份与请求不一致（${p.plan_id} 对应 ${p.scenario_id}@rev${p.scenario_revision}），已丢弃`);
          return;
        }
      }
      for (const r of results) {
        if (r.scenario_id !== scenario.scenario_id || r.scenario_revision !== scenario.revision || r.seed !== seed) {
          fail(`返回结果身份与请求不一致（plan_id=${r.plan_id}），已丢弃`);
          return;
        }
        if (!gen.plans.some((p) => p.plan_id === r.plan_id)) {
          fail(`返回结果引用了未生成的方案 ${r.plan_id}，已丢弃`);
          return;
        }
      }
      if (recommendation?.plan_id && !gen.plans.some((p) => p.plan_id === recommendation.plan_id)) {
        fail(`推荐方案 ${recommendation.plan_id} 不在返回候选中，已丢弃`);
        return;
      }

      dispatch({
        type: "generateDone",
        bundle: {
          scenario_id: scenario.scenario_id,
          scenario_revision: scenario.revision,
          seed,
          objective,
          plans: gen.plans,
          generate_trace: gen.trace,
          generate_mode: gen.mode,
          results,
          recommendation,
          compare_trace: compareTrace,
          compare_mode: compareMode,
          finished_at: Date.now(),
        },
      });
    } catch (err) {
      if (!isLatest("generate", reqId)) return;
      const e = err as ApiError;
      fail(e.message, e.detail);
    }
  }, [dispatch]);

  /** 单方案重新推演（simulate 用于单方案预览，不重复整组比较） */
  const resimulatePlan = useCallback(
    async (plan: Plan) => {
      const s = stateRef.current;
      const reqId = beginRequest("simulate");
      const reqIdentity = scenarioIdentity(s.scenario);
      const { seed } = s;
      dispatch({ type: "simulatePlanStart", planId: plan.plan_id });
      try {
        const result = await api.simulate({ scenario: s.scenario, plan, seed });
        if (!isLatest("simulate", reqId)) return;
        const cur = stateRef.current;
        if (scenarioIdentity(cur.scenario) !== reqIdentity || cur.seed !== seed) {
          dispatch({
            type: "simulatePlanFail",
            planId: plan.plan_id,
            message: staleDropMsg("单方案推演", reqIdentity, scenarioIdentity(cur.scenario)),
          });
          return;
        }
        if (result.plan_id === null || result.scenario_revision === null || result.seed === null) {
          dispatch({
            type: "simulatePlanFail",
            planId: plan.plan_id,
            message: "返回结果缺少完整身份字段（plan_id / scenario_revision / seed），已丢弃",
          });
          return;
        }
        if (result.plan_id !== plan.plan_id || result.scenario_revision !== plan.scenario_revision || result.seed !== seed) {
          dispatch({
            type: "simulatePlanFail",
            planId: plan.plan_id,
            message: `返回结果身份与请求不一致（期望 ${plan.plan_id}@rev${plan.scenario_revision}/seed${seed}，实际 ${result.plan_id}@rev${result.scenario_revision}/seed${result.seed}），已丢弃`,
          });
          return;
        }
        dispatch({ type: "simulatePlanDone", result });
      } catch (err) {
        if (!isLatest("simulate", reqId)) return;
        const e = err as ApiError;
        dispatch({ type: "simulatePlanFail", planId: plan.plan_id, message: e.message, detail: e.detail });
      }
    },
    [dispatch]
  );

  const saveCurrentAsReplay = useCallback(
    (label: string) => {
      const s = stateRef.current;
      if (!s.run) return;
      dispatch({
        type: "saveReplay",
        replay: {
          replay_id: `replay_${Date.now()}`,
          saved_at: Date.now(),
          label,
          scenario: structuredClone(s.scenario),
          bundle: structuredClone(s.run),
        },
      });
    },
    [dispatch]
  );

  const setObjective = useCallback((o: Objective) => dispatch({ type: "setObjective", objective: o }), [dispatch]);
  const setSeed = useCallback((seed: number) => dispatch({ type: "setSeed", seed }), [dispatch]);
  const selectPlan = useCallback((planId: string | null) => dispatch({ type: "selectPlan", planId }), [dispatch]);
  const selectGroup = useCallback((groupId: string | null) => dispatch({ type: "selectGroup", groupId }), [dispatch]);
  const setPlayT = useCallback((t: number) => dispatch({ type: "setPlayT", t }), [dispatch]);
  const setPlaying = useCallback((playing: boolean) => dispatch({ type: "setPlaying", playing }), [dispatch]);
  const dismissError = useCallback((id: number) => dispatch({ type: "dismissError", id }), [dispatch]);
  const loadReplay = useCallback((replayId: string) => dispatch({ type: "loadReplay", replayId }), [dispatch]);
  const exitReplay = useCallback(() => dispatch({ type: "exitReplay" }), [dispatch]);

  return {
    checkHealth,
    parseInstruction,
    applyPendingPatch,
    discardPendingPatch,
    applyManualScenario,
    resetScenario,
    generateAndCompare,
    resimulatePlan,
    saveCurrentAsReplay,
    setObjective,
    setSeed,
    selectPlan,
    selectGroup,
    setPlayT,
    setPlaying,
    dismissError,
    loadReplay,
    exitReplay,
  };
}

/** 当前查看视图（实时 / 回放）下的公共派生状态，供各页面复用 */
export function useViewingBundle() {
  const { state } = useApp();
  const viewing = state.viewing;
  const inReplay = viewing.kind === "replay";
  const bundle = inReplay ? viewing.replay.bundle : state.run;
  const outdated =
    !inReplay && bundle !== null && !runMatchesCurrent(bundle, state.scenario, state.objective, state.seed);
  const scenarioForView = inReplay ? viewing.replay.scenario : state.scenario;
  // engine_ready=false 时禁止生成/比较/推演（health 已校验 schema_version 与 engine_ready）
  const engineBlocked = state.health.state !== "ok" || state.health.engine_ready === false;
  const engineBlockReason =
    state.health.state !== "ok" ? "服务不可达" : state.health.engine_ready === false ? "引擎未就绪" : undefined;
  return { inReplay, bundle, outdated, scenarioForView, engineBlocked, engineBlockReason };
}
