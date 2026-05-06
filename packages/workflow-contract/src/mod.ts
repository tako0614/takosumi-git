/**
 * `@takos/takosumi-git-workflow-contract`
 *
 * Type contracts for workflow YAML files placed under `.takosumi/workflows/`
 * and the events that drive them. The shape mirrors what was previously
 * accepted by the takosumi kernel under `compute.<name>.build.fromWorkflow`,
 * lifted out of the kernel and into this product.
 *
 * Phase 2 skeleton: only the minimum types needed to wire the runner stub.
 */

export type WorkflowEventKind = "manual" | "git-push" | "schedule" | "webhook";

export interface WorkflowEvent {
  readonly kind: WorkflowEventKind;
  readonly source: string;
  readonly payload?: Record<string, unknown>;
}

export interface WorkflowJobSpec {
  readonly name: string;
  readonly steps: readonly WorkflowStepSpec[];
  readonly artifact?: WorkflowArtifactSpec;
}

export interface WorkflowStepSpec {
  readonly name: string;
  readonly run: string;
}

export interface WorkflowArtifactSpec {
  readonly name: string;
  readonly path?: string;
}

export interface WorkflowFile {
  readonly version: "0";
  readonly jobs: readonly WorkflowJobSpec[];
}

export interface WorkflowRunResult {
  readonly job: string;
  readonly artifact?: ResolvedArtifact;
  readonly success: boolean;
  readonly logs: readonly string[];
}

export interface ResolvedArtifact {
  readonly name: string;
  readonly uri: string;
  readonly digest?: string;
}
