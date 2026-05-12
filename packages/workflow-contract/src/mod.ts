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

/**
 * Walk a parsed-YAML value and assert the workflow file shape. The kernel
 * never sees the workflow file — only takosumi-git's workflow-runner
 * consumes it — so a structural assertion here is sufficient to drop
 * `as unknown as WorkflowFile` casts at call sites.
 */
export function parseWorkflowFile(
  value: unknown,
  source: string,
): WorkflowFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: workflow must be a JSON object`);
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== "0") {
    throw new Error(`${source}.version must be "0"`);
  }
  if (!Array.isArray(obj.jobs)) {
    throw new Error(`${source}.jobs must be an array`);
  }
  const jobs: WorkflowJobSpec[] = [];
  for (let i = 0; i < obj.jobs.length; i++) {
    const job = obj.jobs[i];
    if (typeof job !== "object" || job === null || Array.isArray(job)) {
      throw new Error(`${source}.jobs[${i}] must be an object`);
    }
    const jobRecord = job as Record<string, unknown>;
    if (typeof jobRecord.name !== "string") {
      throw new Error(`${source}.jobs[${i}].name must be a string`);
    }
    if (!Array.isArray(jobRecord.steps)) {
      throw new Error(`${source}.jobs[${i}].steps must be an array`);
    }
    const steps: WorkflowStepSpec[] = [];
    for (let s = 0; s < jobRecord.steps.length; s++) {
      const step = jobRecord.steps[s];
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        throw new Error(`${source}.jobs[${i}].steps[${s}] must be an object`);
      }
      const stepRecord = step as Record<string, unknown>;
      if (typeof stepRecord.name !== "string") {
        throw new Error(
          `${source}.jobs[${i}].steps[${s}].name must be a string`,
        );
      }
      if (typeof stepRecord.run !== "string") {
        throw new Error(
          `${source}.jobs[${i}].steps[${s}].run must be a string`,
        );
      }
      steps.push({ name: stepRecord.name, run: stepRecord.run });
    }
    const built: WorkflowJobSpec = { name: jobRecord.name, steps };
    const artifactRaw = jobRecord.artifact;
    if (artifactRaw !== undefined) {
      if (
        typeof artifactRaw !== "object" || artifactRaw === null ||
        Array.isArray(artifactRaw)
      ) {
        throw new Error(`${source}.jobs[${i}].artifact must be an object`);
      }
      const artifactRecord = artifactRaw as Record<string, unknown>;
      if (typeof artifactRecord.name !== "string") {
        throw new Error(
          `${source}.jobs[${i}].artifact.name must be a string`,
        );
      }
      const artifact: WorkflowArtifactSpec = { name: artifactRecord.name };
      if (typeof artifactRecord.path === "string") {
        Object.assign(artifact, { path: artifactRecord.path });
      }
      Object.assign(built, { artifact });
    }
    jobs.push(built);
  }
  return { version: "0", jobs };
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
 * The resolved artifact URI is substituted into `resources[i].spec.image` by
 * default. Projects can set `target` to another `spec.*` field path, such as
 * `spec.artifact.hash` for `worker@v1` uploaded bundle hashes.
 *
 * The type is named `ComputeWorkflowRef` for historical reasons (compute
 * = the runtime-bearing resource family); the structural placement is on
 * any resource entry that needs an upstream-resolved artifact URI.
 */
export interface ComputeWorkflowRef {
  /** Workflow file name relative to the workflows directory (e.g. `build.yml`). */
  readonly file: string;
  /** Job name within the workflow file. */
  readonly job: string;
  /** Artifact name produced by the job; the resolved URI replaces `target`. */
  readonly artifact: string;
  /**
   * Optional manifest field path to receive the resolved artifact URI.
   * Defaults to `spec.image`. Only dotted paths below `spec` are supported.
   */
  readonly target?: `spec.${string}`;
}
