import { TraceStep } from "../../shared/types";

export interface TraceInput {
  actor: string;
  action: string;
  source: TraceStep["source"];
  summary: string;
  input_ref: string;
  output_ref: string;
  status: TraceStep["status"];
  duration_ms?: number;
}

export class TraceRecorder {
  private readonly steps: TraceStep[] = [];

  add(input: TraceInput): TraceStep {
    const step: TraceStep = {
      step: this.steps.length + 1,
      actor: input.actor,
      action: input.action,
      source: input.source,
      summary: input.summary,
      input_ref: input.input_ref,
      output_ref: input.output_ref,
      status: input.status,
    };
    if (typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms)) {
      step.duration_ms = Math.max(0, Math.round(input.duration_ms));
    }
    this.steps.push(step);
    return step;
  }

  list(): TraceStep[] {
    return this.steps.map((step) => ({ ...step }));
  }
}
