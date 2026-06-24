// Kubernetes Pod + Secret manifest builders — extracted from `kubernetesAllocator.ts`
// to keep that file under the 500-line cap. Pure: no IO, no network, no state.

import type { KubernetesPodInput, KubernetesSecretInput } from "./kubernetesShared.js";

/**
 * Manifest for the per-run SSH-key Secret. Carries the runner's PUBLIC SSH key
 * verbatim in `stringData`. The orchestrator's PRIVATE key never transits here.
 */
export function secretManifest(input: KubernetesSecretInput, namespace: string): unknown {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: input.name, namespace, labels: input.labels },
    type: "Opaque",
    stringData: { "ssh-authorized-key": input.sshPublicKey },
  };
}

/**
 * Manifest for the runner Pod. The Pod's `runner` container reads the SSH key
 * from the per-run Secret via env. The env name MUST match what the runner
 * entrypoint reads (`runner/entrypoint.sh`: `TANREN_RUNNER_AUTHORIZED_KEY`) — a
 * mismatch silently leaves the Pod with no authorized_keys and the orchestrator
 * can never SSH in.
 */
export function podManifest(input: KubernetesPodInput, namespace: string): unknown {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: input.name, namespace, labels: input.labels },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "runner",
          image: input.image,
          ports: [{ containerPort: 22, name: "ssh" }],
          env: [
            {
              name: "TANREN_RUNNER_AUTHORIZED_KEY",
              valueFrom: {
                secretKeyRef: { name: input.sshKeySecretName, key: "ssh-authorized-key" },
              },
            },
          ],
        },
      ],
    },
  };
}
