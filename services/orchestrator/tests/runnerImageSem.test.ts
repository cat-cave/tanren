// Dockerfile-inventory assertion: the runner image vendors `sem`, the entity-level
// diff tool the answerer lanes use as an OPTIONAL accelerator
// (docs/roadmap/entity-analysis-layer.md). The answerer Checker/Auditor + issue-triage
// agents shell `sem` over SSH in their read-only sandbox, so it MUST land on PATH in
// the runner image. This pins the install: a pinned version, arch mapping, checksum
// verification against the release's combined checksums.txt, and a self-test, mirroring
// the codexbar/jj/just installs. If the install block is dropped or stops verifying the
// download, this fails loudly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(fileURLToPath(new URL("../../../runner/Dockerfile", import.meta.url)), "utf8");

describe("runner image — sem entity-diff tool inventory", () => {
  it("vendors a pinned sem from the upstream release", () => {
    expect(dockerfile).toContain("ARG SEM_VERSION=");
    // The prebuilt release binary (cargo install fails on the OpenSSL native-dep).
    expect(dockerfile).toContain("https://github.com/Ataraxy-Labs/sem/releases/download/v${SEM_VERSION}");
    expect(dockerfile).toContain('ASSET="sem-${SEM_ARCH}.tar.gz"');
    // Built from the release binary, NOT `cargo install` (it fails on the OpenSSL
    // native-dep). The RUN layer must not invoke cargo.
    expect(dockerfile).not.toContain("cargo install --git");
    expect(dockerfile).not.toContain("RUN cargo");
  });

  it("arch-maps both linux targets", () => {
    expect(dockerfile).toContain('amd64) SEM_ARCH="linux-x86_64"');
    expect(dockerfile).toContain('arm64) SEM_ARCH="linux-arm64"');
  });

  it("verifies the download against the release checksums and installs onto PATH", () => {
    expect(dockerfile).toContain("checksums.txt");
    expect(dockerfile).toContain("sem sha256 mismatch");
    expect(dockerfile).toContain("install -m 0755 /tmp/sem/sem /usr/local/bin/sem");
    // Self-test so a broken download fails the build.
    expect(dockerfile).toContain("sem --version");
  });
});
