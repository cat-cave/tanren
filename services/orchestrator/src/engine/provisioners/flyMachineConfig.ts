/**
 * Fly Machines release configuration shared by static and merge-reflecting
 * image deployments. The service maps edge ports 80/443 to the app's port 3000.
 */
export function flyMachineConfig(image: string): Record<string, unknown> {
  return {
    image,
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
    services: [
      {
        protocol: "tcp",
        internal_port: 3000,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
      },
    ],
    checks: {
      httpget: {
        type: "http",
        port: 3000,
        method: "get",
        path: "/",
        interval: "15s",
        // eslint-disable-next-line no-inline-comments -- Fly's per-probe API setting, not a workflow deadline.
        timeout: "10s", // arch-allow: timeout-class
        grace_period: "10s",
      },
    },
  };
}
