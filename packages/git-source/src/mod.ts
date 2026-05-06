/**
 * `@takos/takosumi-git-source`
 *
 * Translates incoming git push / webhook payloads into normalized
 * `WorkflowEvent` records that the workflow runner consumes. Transport,
 * signature verification, queueing, and dispatch live in the takosumi-git CLI
 * `serve` command so this package stays transport-neutral.
 */

import type { WorkflowEvent } from "@takos/takosumi-git-workflow-contract";

export interface GitPushPayload {
  readonly repo: string;
  readonly ref: string;
  readonly commit: string;
  readonly pusher?: string;
}

export interface WebhookPayload {
  readonly source: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export function eventFromGitPush(payload: GitPushPayload): WorkflowEvent {
  return {
    kind: "git-push",
    source: `${payload.repo}@${payload.ref}`,
    payload: {
      repo: payload.repo,
      ref: payload.ref,
      commit: payload.commit,
      pusher: payload.pusher,
    },
  };
}

export function eventFromWebhook(payload: WebhookPayload): WorkflowEvent {
  return {
    kind: "webhook",
    source: payload.source,
    payload: {
      headers: payload.headers,
      body: payload.body,
    },
  };
}

export function manualEvent(reason: string): WorkflowEvent {
  return { kind: "manual", source: reason };
}
