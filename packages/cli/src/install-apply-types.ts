/**
 * Shared type definitions for the install-apply module family.
 *
 * Separated from `install-apply.ts` so helper / launch-token / placeholders
 * modules can import these types without a circular dependency.
 */

export interface AccountsInstallResponseSummary {
  readonly installationId?: string;
  readonly runtimeBinding?: Record<string, unknown>;
  readonly bindings: readonly Record<string, unknown>[];
  readonly oidcClient?: Record<string, unknown>;
  readonly oidcClientSecret?: string;
  readonly bindingEnv?: Record<string, string>;
  readonly launchTokenConfig?: Record<string, unknown>;
}

export class InstallApplyError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Takosumi Accounts returned HTTP ${status}`);
    this.name = "InstallApplyError";
  }
}
