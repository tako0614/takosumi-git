/**
 * `takosumi-git install` preview construction.
 *
 * Builds an `InstallPreview` from a parsed `InstallableApp` and computes
 * publisher verification, risk level, cost estimate, and approval flags.
 * Also exposes content-digest helpers used by other install-* modules.
 */

import { createHash } from "node:crypto";
import {
  fullCommitPattern,
  type InstallableApp,
  type InstallableAppBindingType,
  type InstallableAppPermission,
  type InstallableAppRuntimeMode,
  releaseTagPattern,
  semverTagPattern,
} from "./install-parse.ts";

export interface InstallPreview {
  readonly kind: "takosumi-git.install-preview@v1";
  readonly previewId: `preview_${string}`;
  readonly expiresAt: string;
  readonly app: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly homepage: string;
  };
  readonly publisher: {
    readonly id: string;
    readonly verified: boolean;
    readonly signingKeyFingerprint?: string;
  };
  readonly source: {
    readonly git: string;
    readonly ref: string;
    readonly commit?: string;
    readonly pinned: boolean;
    readonly appManifestDigest?: string;
    readonly compiledManifestDigest?: string;
    readonly manifestPath: string;
  };
  readonly runtime: {
    readonly modes: readonly InstallableAppRuntimeMode[];
  };
  readonly bindings: readonly {
    readonly name: string;
    readonly type: InstallableAppBindingType;
    readonly required: boolean;
    readonly redirectPaths?: readonly string[];
  }[];
  readonly permissions: {
    readonly requested: readonly InstallableAppPermission[];
  };
  readonly permissionDigest: `sha256:${string}`;
  readonly cost: {
    readonly estimate: "unknown";
    readonly meteredBindingCount: number;
    readonly note: string;
  };
  readonly risk: {
    readonly level: "low" | "medium" | "high";
    readonly reasons: readonly string[];
  };
  readonly approvalRequired: boolean;
  readonly warnings: readonly string[];
}

export interface PublisherVerificationRecord {
  readonly publisher: string;
  readonly homepage: string;
  readonly signingKeyFingerprint: string;
  readonly verifiedAt: string;
  readonly method: "dns-txt";
}

export function digestText(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${
    createHash("sha256").update(JSON.stringify(canonicalize(value))).digest(
      "hex",
    )
  }`;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const canonical = canonicalize((value as Record<string, unknown>)[key]);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  }
  return value;
}

export function isPinnedSource(app: InstallableApp): boolean {
  return !!app.source.commit || fullCommitPattern.test(app.source.ref) ||
    app.source.ref.startsWith("refs/tags/") ||
    semverTagPattern.test(app.source.ref) ||
    releaseTagPattern.test(app.source.ref);
}

function hasSourceCommitPin(app: InstallableApp): boolean {
  return !!app.source.commit || fullCommitPattern.test(app.source.ref);
}

function sameHomepageOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function hasPublisherVerificationMinimum(
  app: InstallableApp,
  options: {
    readonly appManifestDigest?: string;
    readonly publisherVerification?: PublisherVerificationRecord;
  },
): boolean {
  const record = options.publisherVerification;
  return !!record &&
    !!app.metadata.signingKeyFingerprint &&
    record.publisher === app.metadata.publisher &&
    sameHomepageOrigin(record.homepage, app.metadata.homepage) &&
    record.signingKeyFingerprint === app.metadata.signingKeyFingerprint &&
    record.method === "dns-txt" &&
    Number.isFinite(Date.parse(record.verifiedAt)) &&
    hasSourceCommitPin(app) &&
    !!options.appManifestDigest;
}

export function buildInstallPreview(
  app: InstallableApp,
  options: {
    readonly appManifestDigest?: string;
    readonly compiledManifestDigest?: string;
    readonly warnings?: readonly string[];
    readonly now?: Date;
    readonly publisherVerification?: PublisherVerificationRecord;
  } = {},
): InstallPreview {
  const bindings = Object.entries(app.bindings).map(([name, binding]) => ({
    name,
    type: binding.type,
    required: binding.required,
    ...(binding.redirectPaths ? { redirectPaths: binding.redirectPaths } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const meteredBindingCount =
    bindings.filter((binding) =>
      binding.type === "database.postgres@v1" ||
      binding.type === "object-store.s3-compatible@v1" ||
      binding.type === "domain.http@v1"
    ).length;
  const permissionDigest = digestJson({
    bindingKinds: bindings.map((binding) => binding.type).sort(),
    grants: [...app.permissions.requested].sort(),
  });
  const publisherVerified = hasPublisherVerificationMinimum(app, options);
  const risk = installPreviewRisk({
    verifiedPublisher: publisherVerified,
    pinnedSource: isPinnedSource(app),
    requiredMeteredBindingCount: bindings.filter((binding) =>
      binding.required &&
      (binding.type === "database.postgres@v1" ||
        binding.type === "object-store.s3-compatible@v1" ||
        binding.type === "domain.http@v1")
    ).length,
  });
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const previewId = `preview_${
    digestJson({
      appId: app.metadata.id,
      source: app.source,
      bindings,
      permissions: app.permissions.requested,
      appManifestDigest: options.appManifestDigest,
      compiledManifestDigest: options.compiledManifestDigest,
    }).slice("sha256:".length, "sha256:".length + 24)
  }` as const;
  return {
    kind: "takosumi-git.install-preview@v1",
    previewId,
    expiresAt,
    app: {
      id: app.metadata.id,
      name: app.metadata.name,
      description: app.metadata.description,
      homepage: app.metadata.homepage,
    },
    publisher: {
      id: app.metadata.publisher,
      verified: publisherVerified,
      ...(app.metadata.signingKeyFingerprint
        ? { signingKeyFingerprint: app.metadata.signingKeyFingerprint }
        : {}),
    },
    source: {
      git: app.source.git,
      ref: app.source.ref,
      ...(app.source.commit ? { commit: app.source.commit } : {}),
      pinned: isPinnedSource(app),
      ...(options.appManifestDigest
        ? { appManifestDigest: options.appManifestDigest }
        : {}),
      ...(options.compiledManifestDigest
        ? { compiledManifestDigest: options.compiledManifestDigest }
        : {}),
      manifestPath: app.entry.manifest,
    },
    runtime: { modes: app.runtime.modes },
    bindings,
    permissions: { requested: app.permissions.requested },
    permissionDigest,
    cost: {
      estimate: "unknown",
      meteredBindingCount,
      note:
        "Cost is provider-specific until AppInstallation binding resolution runs.",
    },
    risk,
    approvalRequired: risk.level !== "low" || meteredBindingCount > 0,
    warnings: options.warnings ?? [],
  };
}

function installPreviewRisk(input: {
  readonly verifiedPublisher: boolean;
  readonly pinnedSource: boolean;
  readonly requiredMeteredBindingCount: number;
}): InstallPreview["risk"] {
  const reasons: string[] = [];
  if (!input.verifiedPublisher) reasons.push("publisher is not verified");
  if (!input.pinnedSource) {
    reasons.push("source is not pinned to an immutable ref");
  }
  if (input.requiredMeteredBindingCount > 0) {
    reasons.push(
      `${input.requiredMeteredBindingCount} required metered binding(s) need provider approval`,
    );
  }
  const level = !input.verifiedPublisher || !input.pinnedSource
    ? "high"
    : input.requiredMeteredBindingCount > 0
    ? "medium"
    : "low";
  return { level, reasons };
}

export function renderHumanPreview(preview: InstallPreview): string {
  const lines = [
    "takosumi-git install preview",
    `app: ${preview.app.name} (${preview.app.id})`,
    `publisher: ${preview.publisher.id} (${
      preview.publisher.verified ? "verified" : "unverified"
    })`,
    `preview: ${preview.previewId} expires ${preview.expiresAt}`,
    `source: ${preview.source.git} @ ${preview.source.ref}`,
    `entry manifest: ${preview.source.manifestPath}${
      preview.source.compiledManifestDigest
        ? ` (${preview.source.compiledManifestDigest})`
        : ""
    }`,
    `runtime: ${preview.runtime.modes.join(", ")}`,
    "bindings:",
    ...preview.bindings.map((binding) =>
      `  - ${binding.name}: ${binding.type} ${
        binding.required ? "required" : "optional"
      }${
        binding.redirectPaths
          ? ` redirects=${binding.redirectPaths.join(",")}`
          : ""
      }`
    ),
    "permissions:",
    ...(preview.permissions.requested.length > 0
      ? preview.permissions.requested.map((permission) => `  - ${permission}`)
      : ["  - none"]),
    `cost: ${preview.cost.estimate} (${preview.cost.meteredBindingCount} metered binding(s))`,
    `risk: ${preview.risk.level}${
      preview.approvalRequired ? " (approval required)" : ""
    }`,
  ];
  if (preview.source.appManifestDigest) {
    lines.push(`app manifest: ${preview.source.appManifestDigest}`);
  }
  if (preview.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of preview.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
