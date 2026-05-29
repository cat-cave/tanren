import { describe, expect, it } from "vitest";
import {
  AwsSecretsManagerStore,
  awsSecretNameFromRef,
  buildSecretStore,
  GcpSecretManagerStore,
  gcpSecretIdFromRef,
  InMemorySecretStore,
  OnePasswordStore,
  onePasswordTitleFromRef,
  VaultSecretStore,
} from "../src/engine/contracts/index.js";

const agnosticRef = "credential/github_token/org/acme/default";

describe("buildSecretStore selector", () => {
  it("defaults to Vault for back-compat when TANREN_SECRET_STORE is unset", () => {
    const store = buildSecretStore({});
    expect(store).toBeInstanceOf(VaultSecretStore);
  });

  it("selects each backend by TANREN_SECRET_STORE", () => {
    expect(buildSecretStore({ TANREN_SECRET_STORE: "memory" })).toBeInstanceOf(InMemorySecretStore);
    expect(buildSecretStore({ TANREN_SECRET_STORE: "vault" })).toBeInstanceOf(VaultSecretStore);
    expect(
      buildSecretStore({
        TANREN_SECRET_STORE: "gcp_sm",
        TANREN_GCP_SM_PROJECT: "p",
        TANREN_GCP_SM_ACCESS_TOKEN: "t",
      }),
    ).toBeInstanceOf(GcpSecretManagerStore);
    expect(
      buildSecretStore({
        TANREN_SECRET_STORE: "aws_sm",
        TANREN_AWS_SM_ACCESS_KEY_ID: "k",
        TANREN_AWS_SM_SECRET_ACCESS_KEY: "s",
        TANREN_AWS_SM_REGION: "us-east-1",
      }),
    ).toBeInstanceOf(AwsSecretsManagerStore);
    expect(
      buildSecretStore({
        TANREN_SECRET_STORE: "onepassword",
        TANREN_OP_CONNECT_URL: "https://connect.example.com",
        TANREN_OP_CONNECT_TOKEN: "t",
        TANREN_OP_VAULT_ID: "v",
      }),
    ).toBeInstanceOf(OnePasswordStore);
  });

  it("throws a helpful error for an unknown backend", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "bogus" })).toThrow(/unknown TANREN_SECRET_STORE/);
  });

  it("throws when a selected backend is missing required credentials", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "gcp_sm" })).toThrow(/TANREN_GCP_SM_PROJECT/);
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "aws_sm" })).toThrow(/TANREN_AWS_SM_/);
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "onepassword" })).toThrow(/TANREN_OP_/);
  });
});

describe("ref -> backend key mapping", () => {
  it("GCP sanitizes the ref into a valid Secret Manager id", () => {
    expect(gcpSecretIdFromRef(agnosticRef)).toBe("credential_github_token_org_acme_default");
    // Deterministic + total within the id charset.
    expect(gcpSecretIdFromRef(agnosticRef)).toBe(gcpSecretIdFromRef(agnosticRef));
    expect(gcpSecretIdFromRef("")).toBe("_");
  });

  it("AWS uses the ref verbatim, optionally prefixed", () => {
    expect(awsSecretNameFromRef(agnosticRef)).toBe(agnosticRef);
    expect(awsSecretNameFromRef(agnosticRef, "tanren")).toBe(`tanren/${agnosticRef}`);
  });

  it("1Password uses the ref as the item title", () => {
    expect(onePasswordTitleFromRef(agnosticRef)).toBe(agnosticRef);
  });
});
