/**
 * `@takos/takosumi-git-workflow-runner`
 *
 * Executes a `WorkflowFile` job, resolves its artifact URI, and returns the
 * `ResolvedArtifact` so that a manifest can be generated against it.
 *
 * Phase 2 skeleton: actual subprocess / build execution is stubbed. The
 * runner accepts an injected step executor so tests can drive the flow
 * without spawning processes, and so a future implementation can wire in
 * containerd / docker / native exec without touching this module's API.
 */

import type {
  ResolvedArtifact,
  WorkflowEvent,
  WorkflowFile,
  WorkflowJobSpec,
  WorkflowRunResult,
} from "@takos/takosumi-git-workflow-contract";

export interface StepExecutor {
  (run: string, context: StepContext): Promise<StepOutcome>;
}

export interface StepContext {
  readonly job: string;
  readonly step: string;
  readonly event: WorkflowEvent;
}

export interface StepOutcome {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface ArtifactResolver {
  (job: WorkflowJobSpec, event: WorkflowEvent): Promise<ResolvedArtifact>;
}

export interface RunWorkflowOptions {
  readonly file: WorkflowFile;
  readonly job: string;
  readonly event: WorkflowEvent;
  readonly executor: StepExecutor;
  readonly resolveArtifact: ArtifactResolver;
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const job = options.file.jobs.find((j) => j.name === options.job);
  if (!job) {
    return {
      job: options.job,
      success: false,
      logs: [`job '${options.job}' not found in workflow file`],
    };
  }
  const logs: string[] = [];
  for (const step of job.steps) {
    const outcome = await options.executor(step.run, {
      job: job.name,
      step: step.name,
      event: options.event,
    });
    logs.push(`step ${step.name}: exit=${outcome.exitCode}`);
    if (outcome.stdout) logs.push(outcome.stdout);
    if (outcome.exitCode !== 0) {
      return { job: job.name, success: false, logs };
    }
  }
  if (!job.artifact) {
    return { job: job.name, success: true, logs };
  }
  const artifact = await options.resolveArtifact(job, options.event);
  return { job: job.name, success: true, logs, artifact };
}
