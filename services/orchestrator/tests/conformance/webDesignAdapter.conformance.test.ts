// ds-2 — adversarial DesignTargetAdapter conformance for the web React target.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import type { EventStore } from "../../src/engine/eventStore.js";
import { FilesystemArtifactStore, sha256Digest } from "../../src/engine/design/system/artifactStore.js";
import { resolveDtcgTokens } from "../../src/engine/design/system/dtcgResolver.js";
import { WebDesignTargetAdapter } from "../../src/engine/design/system/webAdapter.js";
import { WebTokenProjectionError } from "../../src/engine/design/system/webTokens.js";
import { renderWebDesignSystemBlock } from "../../src/engine/design/system/webWriterContext.js";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function adapter(): WebDesignTargetAdapter {
  return new WebDesignTargetAdapter({
    designSystemId: "system_web",
    releaseId: "release_web_1",
    tokens: resolveDtcgTokens({
      color: {
        background: { $type: "color", $value: "#ffffff" },
        border: { $type: "color", $value: "#d0d5dd" },
        foreground: { $type: "color", $value: "#101828" },
        primary: { $type: "color", $value: "#155eef" },
      },
      radius: { md: { $type: "dimension", $value: "0.375rem" } },
      space: { md: { $type: "dimension", $value: "0.5rem" } },
    }),
  });
}

function buildInput() {
  return {
    artifactId: "artifact_web_1",
    contractDigest: digest("a"),
    plainReleaseDigest: digest("b"),
    polishedReleaseDigest: digest("c"),
    fragmentLineage: ["fragment_plain", "fragment_web"],
  };
}

describe("DesignTargetAdapter conformance: web-react", () => {
  it("deterministically projects resolved tokens and implements every required adapter operation", async () => {
    const first = adapter();
    const second = adapter();
    const profile = { target: "web-react", capabilities: ["css-variables", "tailwind", "catalog", "exports"] };
    const workspace = { root: "/workspace", listFiles: async () => ["package.json", "src/app.tsx"] };

    await expect(first.detectTarget(workspace)).resolves.toEqual({
      applies: true,
      satisfiedCapabilities: expect.arrayContaining(["radix", "shadcn", "tailwind"]),
      unsatisfiedCapabilities: [],
    });
    const firstVfs = await first.bootstrapPlainSystem(profile);
    const secondVfs = await second.bootstrapPlainSystem(profile);
    expect(firstVfs.files).toEqual(secondVfs.files);
    expect(firstVfs.fileAt("styles/tokens.css")?.digest).toBe(secondVfs.fileAt("styles/tokens.css")?.digest);
    expect(await first.validateStatic(firstVfs)).toEqual({ ok: true, checkKey: "web-react.static.v1", findings: [] });

    const materialized = await first.materialize([], firstVfs);
    expect(await first.buildCatalog(materialized)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "catalog/components.json", kind: "catalog" })]),
    );
    expect(await first.renderScenarioMatrix(materialized, profile)).toHaveLength(20);
    expect(await first.enumerateProofRequirements(profile)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "web.exports", kind: "export", critical: true })]),
    );

    const artifact = first.buildArtifact(buildInput());
    await expect(first.export("tailwind", artifact.manifest)).resolves.toEqual([
      expect.objectContaining({ path: "exports/tailwind.config.ts", kind: "export" }),
    ]);
  });

  it("builds a shadcn/Radix catalog with resolved token bindings and makes it Writer-consumable", () => {
    const artifact = adapter().buildArtifact(buildInput());
    expect(artifact.catalog).toMatchObject({ schemaVersion: 1, framework: "react", style: "shadcn" });
    expect(artifact.catalog.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "dialog", primitive: "@radix-ui/react-dialog" }),
        expect.objectContaining({ key: "button", sourcePath: "components/ui/button.tsx" }),
      ]),
    );
    expect(artifact.catalog.components.find((component) => component.key === "button")?.tokenBindings).toMatchObject({
      background: "--tanren-color-primary",
      radius: "--tanren-radius-md",
    });
    const writerBlock = renderWebDesignSystemBlock(artifact.writerContext);
    expect(writerBlock).toContain("--tanren-color-primary = #155eef");
    expect(writerBlock).toContain("dialog (@radix-ui/react-dialog; components/ui/dialog.tsx)");
  });

  it("round-trips every exported byte and the framework manifest through ds-1's sha256 CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-web-adapter-"));
    roots.push(root);
    const store = new FilesystemArtifactStore(root);
    const artifact = adapter().buildArtifact(buildInput());

    for (const file of artifact.files) {
      await expect(store.put(file.bytes)).resolves.toBe(file.digest);
      await expect(store.get(file.digest)).resolves.toEqual(file.bytes);
    }
    const manifestDigest = await store.put(artifact.manifestBytes);
    expect(manifestDigest).toBe(sha256Digest(artifact.manifestBytes));
    await expect(store.get(manifestDigest)).resolves.toEqual(artifact.manifestBytes);
    expect(JSON.parse(new TextDecoder().decode(await store.get(manifestDigest)))).toEqual(artifact.manifest);
  });

  it("persists metadata/files under org scope and emits only the frozen web-design events", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-web-publish-"));
    roots.push(root);
    const pool = new ArtifactMetadataPool();
    const events: string[] = [];
    const eventStore: EventStore = { append: async (input) => void events.push(input.eventType) };
    const persisted = await adapter().publish({
      ...buildInput(),
      pool: pool as unknown as pg.Pool,
      artifactStore: new FilesystemArtifactStore(root),
      eventStore,
      orgId: "org_web",
      projectId: "project_web",
    });

    expect(pool.queries).toContain("SET LOCAL app.current_org_id = 'org_web'");
    expect(pool.artifacts).toHaveLength(1);
    expect(pool.files).toHaveLength(adapter().buildArtifact(buildInput()).files.length);
    expect(persisted.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(events).toEqual([
      "design.catalog.built",
      "design.export.produced",
      "design.export.produced",
      "design.export.produced",
      "design.export.produced",
      "design.artifact.published",
    ]);
  });

  it("NEGATIVE CONTROL — missing or non-CSS token values fail loud instead of producing a partial catalog", () => {
    expect(
      () =>
        new WebDesignTargetAdapter({
          designSystemId: "system_missing_color",
          releaseId: "release_missing_color",
          tokens: resolveDtcgTokens({ space: { md: { $type: "dimension", $value: "0.5rem" } } }),
        }),
    ).toThrow(WebTokenProjectionError);
    expect(
      () =>
        new WebDesignTargetAdapter({
          designSystemId: "system_malformed_value",
          releaseId: "release_malformed_value",
          tokens: resolveDtcgTokens({
            color: { primary: { $type: "color", $value: { unsupported: true } } },
            space: { md: { $type: "dimension", $value: "0.5rem" } },
          }),
        }),
    ).toThrow(WebTokenProjectionError);
  });
});

interface StoredArtifact {
  readonly design_system_id: string;
  readonly digest: string;
  readonly media_type: string;
  readonly manifest_version: number;
  readonly object_store_key: string;
  readonly byte_size: number;
}

interface StoredFile {
  readonly path: string;
  readonly kind: string;
  readonly media_type: string;
  readonly digest: string;
  readonly byte_size: number;
  readonly executable: boolean;
}

class ArtifactMetadataPool {
  readonly queries: string[] = [];
  readonly artifacts: StoredArtifact[] = [];
  readonly files: StoredFile[] = [];

  async connect(): Promise<ArtifactMetadataClient> {
    return new ArtifactMetadataClient(this);
  }
}

class ArtifactMetadataClient {
  constructor(private readonly pool: ArtifactMetadataPool) {}

  release(): void {}

  async query<T>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.pool.queries.push(text);
    if (text.includes("INSERT INTO design_artifacts")) {
      this.pool.artifacts.push({
        design_system_id: String(values[2]),
        digest: String(values[3]),
        media_type: String(values[4]),
        manifest_version: Number(values[5]),
        object_store_key: String(values[6]),
        byte_size: Number(values[7]),
      });
      return { rows: [] };
    }
    if (text.includes("FROM design_artifacts")) return { rows: this.pool.artifacts as T[] };
    if (text.includes("INSERT INTO design_artifact_files")) {
      this.pool.files.push({
        path: String(values[2]),
        kind: String(values[3]),
        media_type: String(values[4]),
        digest: String(values[5]),
        byte_size: Number(values[6]),
        executable: values[7] === true,
      });
      return { rows: [] };
    }
    if (text.includes("FROM design_artifact_files")) return { rows: this.pool.files as T[] };
    return { rows: [] };
  }
}
