/**
 * `@takos/takosumi-git-workflow-contract`
 *
 * Type contracts for workflow YAML files placed under `.takosumi/workflows/`
 * and the events that drive them. The previous home of the workflow concept
 * was the takosumi kernel itself (`compute.<name>.build.fromWorkflow`); it
 * has been lifted out of the kernel into this product, and now attaches to
 * the takosumi v1 manifest envelope as `resources[i].workflowRef` (a
 * private takosumi-git extension that is stripped before submission).
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

/**
 * Reference embedded as `resources[i].workflowRef` on a takosumi v1
 * manifest entry to bind that resource to a workflow job + artifact.
 * This is a takosumi-git private extension to the manifest YAML — it is
 * parsed by `takosumi-git push`, used to drive workflow execution, and
 * **stripped before the manifest is submitted to the takosumi kernel**
 * (which would otherwise reject it as an unknown field on the closed
 * resource entry shape).
 *
 * The resolved artifact URI is substituted into `resources[i].spec.image`.
 *
 * The type is named `ComputeWorkflowRef` for historical reasons (compute
 * = the runtime-bearing resource family); the structural placement is on
 * any resource entry that needs an upstream-resolved image URI.
 */
export interface ComputeWorkflowRef {
  /** Workflow file name relative to the workflows directory (e.g. `build.yml`). */
  readonly file: string;
  /** Job name within the workflow file. */
  readonly job: string;
  /** Artifact name produced by the job; the resolved URI replaces `spec.image`. */
  readonly artifact: string;
}
