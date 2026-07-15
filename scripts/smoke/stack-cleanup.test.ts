import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStackContext, resolveHostPorts, withExecutionRoot } from "./stack-context.js";
import { forceRemoveOwnedResources, teardownCandidateStack } from "./stack-cleanup.js";
import { LifecycleLedger } from "./stack-lifecycle.js";
import { BUILD_ID_LABEL } from "./stack-provenance.js";

const roots: string[] = [];

afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("exact-label stack cleanup", () => {
  it("lets a finite delayed Compose teardown reach its terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-cleanup-delayed-"));
    roots.push(root);
    const runtime = join(root, "runtime.cjs");
    const completionPath = join(root, "compose-completed");
    const context = withExecutionRoot(
      createStackContext({
        root,
        head: "e".repeat(40),
        tree: "f".repeat(40),
        runId: "cleanup-delayed",
        nonce: "1".repeat(32),
        runtimeBase: join(root, "owned-runtime"),
        receiptPath: join(root, "receipt.json"),
        ports: resolveHostPorts({}, 1_600),
      }),
      root,
    );
    await mkdir(context.runtimeDir, { recursive: true });
    await writeFile(context.explicitEnvPath, "");
    await writeFile(
      runtime,
      `#!${process.execPath}\n` +
        `const fs=require('fs');const a=process.argv.slice(2);` +
        `if(a[0]==='compose'){setTimeout(()=>fs.writeFileSync(process.env.COMPLETION_FILE,'done'),150)}`,
      { mode: 0o755 },
    );
    await chmod(runtime, 0o755);
    await teardownCandidateStack(
      context,
      { provider: "podman", executable: runtime, socket: join(root, "fake.sock") },
      { ...process.env, COMPLETION_FILE: completionPath },
      new LifecycleLedger(),
    );
    expect(await readFile(completionPath, "utf8")).toBe("done");
  });

  it("force-removes nonempty owned resources after compose failure and preserves foreign decoys", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-cleanup-"));
    roots.push(root);
    const runtime = join(root, "runtime.cjs");
    const statePath = join(root, "state.json");
    const context = withExecutionRoot(
      createStackContext({
        root,
        head: "a".repeat(40),
        tree: "b".repeat(40),
        runId: "cleanup",
        nonce: "c".repeat(32),
        runtimeBase: join(root, "owned-runtime"),
        receiptPath: join(root, "receipt.json"),
        ports: resolveHostPorts({}, 1_200),
      }),
      root,
    );
    const projectLabel = "com.docker.compose.project";
    await mkdir(context.runtimeDir, { recursive: true });
    await writeFile(context.explicitEnvPath, "");
    const initial = {
      commands: [] as string[][],
      containers: {
        "owned-container": { [projectLabel]: context.project },
        "foreign-container": { [projectLabel]: "foreign-project" },
      },
      networks: {
        "owned-network": { [projectLabel]: context.project },
        "foreign-network": { [projectLabel]: "foreign-project" },
      },
      volumes: {
        "owned-volume": { [projectLabel]: context.project },
        "foreign-volume": { [projectLabel]: "foreign-project" },
      },
      images: {
        "owned-image": { [BUILD_ID_LABEL]: context.buildId },
        "foreign-image": { [BUILD_ID_LABEL]: "foreign-build" },
      },
    };
    await writeFile(statePath, JSON.stringify(initial));
    await writeFile(
      runtime,
      `#!${process.execPath}\n` +
        `const fs=require('fs');const p=process.env.STATE_FILE;const l=p+'.lock';` +
        `for(;;){try{fs.mkdirSync(l);break}catch(e){if(e.code!=='EEXIST')throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}` +
        `const a=process.argv.slice(2);` +
        `const s=JSON.parse(fs.readFileSync(p,'utf8'));s.commands.push(a);` +
        `const save=()=>{const t=p+'.'+process.pid;fs.writeFileSync(t,JSON.stringify(s));fs.renameSync(t,p);fs.rmdirSync(l)};` +
        `const out=x=>process.stdout.write(x.join('\\n')+(x.length?'\\n':''));` +
        `const noun={container:'containers',network:'networks',volume:'volumes',image:'images'};` +
        `if(a[0]==='compose'){save();process.exit(9);}` +
        `if(a[0]==='ps'){out(Object.keys(s.containers).filter(k=>s.containers[k][${JSON.stringify(projectLabel)}]===${JSON.stringify(context.project)}));save();}` +
        `else if(noun[a[0]]&&a[1]==='ls'){const n=noun[a[0]],label=a.find(x=>x.startsWith('label='))?.slice(6).split('=');out(Object.keys(s[n]).filter(k=>s[n][k][label[0]]===label.slice(1).join('=')));save();}` +
        `else if(noun[a[0]]&&a[1]==='inspect'){const n=noun[a[0]],v=s[n][a[2]];save();if(!v)process.exit(1);process.stdout.write(JSON.stringify([{Labels:v,Config:{Labels:v}}]));}` +
        `else {let n,id;if(a[0]==='rm'){n='containers';id=a.at(-1)}else if(noun[a[0]]&&a[1]==='rm'){n=noun[a[0]];id=a.at(-1)}if(n)delete s[n][id];save();}`,
      { mode: 0o755 },
    );
    await chmod(runtime, 0o755);
    const binding = { provider: "docker" as const, executable: runtime, socket: join(root, "fake.sock") };
    const env = { ...process.env, STATE_FILE: statePath };
    await forceRemoveOwnedResources(context, binding, env, new LifecycleLedger(), {
      containers: ["owned-container", "foreign-container"],
      networks: ["owned-network", "foreign-network"],
      volumes: ["owned-volume", "foreign-volume"],
      images: ["owned-image", "foreign-image"],
    });
    const guarded = JSON.parse(await readFile(statePath, "utf8")) as typeof initial;
    expect(guarded.containers).toEqual({ "foreign-container": { [projectLabel]: "foreign-project" } });
    expect(guarded.commands.some((args) => args.join(" ") === "rm -f foreign-container")).toBe(false);
    expect(guarded.commands.some((args) => args.join(" ") === "container inspect foreign-container")).toBe(true);
    await writeFile(statePath, JSON.stringify(initial));
    await teardownCandidateStack(context, binding, env, new LifecycleLedger());
    const final = JSON.parse(await readFile(statePath, "utf8")) as typeof initial;
    expect(final.containers).toEqual({ "foreign-container": { [projectLabel]: "foreign-project" } });
    expect(final.networks).toEqual({ "foreign-network": { [projectLabel]: "foreign-project" } });
    expect(final.volumes).toEqual({ "foreign-volume": { [projectLabel]: "foreign-project" } });
    expect(final.images).toEqual({ "foreign-image": { [BUILD_ID_LABEL]: "foreign-build" } });
    expect(final.commands.some((args) => args.includes("--rmi"))).toBe(false);
    expect(final.commands.some((args) => args.join(" ") === "rm -f foreign-container")).toBe(false);
  });

  it("force-removes Podman lowercase-label owned networks and preserves foreign/malformed decoys", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-cleanup-podman-"));
    roots.push(root);
    const runtime = join(root, "runtime.cjs");
    const statePath = join(root, "state.json");
    const context = withExecutionRoot(
      createStackContext({
        root,
        head: "1".repeat(40),
        tree: "2".repeat(40),
        runId: "cleanup-podman",
        nonce: "d".repeat(32),
        runtimeBase: join(root, "owned-runtime"),
        receiptPath: join(root, "receipt.json"),
        ports: resolveHostPorts({}, 1_400),
      }),
      root,
    );
    const projectLabel = "com.docker.compose.project";
    await mkdir(context.runtimeDir, { recursive: true });
    await writeFile(context.explicitEnvPath, "");
    const initial = {
      commands: [] as string[][],
      networks: {
        "owned-network": { labels: { [projectLabel]: context.project }, containers: {} },
        "foreign-network": { labels: { [projectLabel]: "foreign-project" }, containers: {} },
        "array-labels": { labels: [{ evil: "true" }], containers: {} },
        "missing-labels": { containers: {} },
        "non-string-label": { labels: { [projectLabel]: 123 }, containers: {} },
      },
    };
    await writeFile(statePath, JSON.stringify(initial));
    await writeFile(
      runtime,
      `#!${process.execPath}\n` +
        `const fs=require('fs');const p=process.env.STATE_FILE;const l=p+'.lock';` +
        `for(;;){try{fs.mkdirSync(l);break}catch(e){if(e.code!=='EEXIST')throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}` +
        `const a=process.argv.slice(2);` +
        `const s=JSON.parse(fs.readFileSync(p,'utf8'));s.commands.push(a);` +
        `const save=()=>{const t=p+'.'+process.pid;fs.writeFileSync(t,JSON.stringify(s));fs.renameSync(t,p);fs.rmdirSync(l)};` +
        `if(a[0]==='network'&&a[1]==='inspect'){const v=s.networks[a[2]];save();if(!v)process.exit(1);process.stdout.write(JSON.stringify([v]));}` +
        `else if(a[0]==='network'&&a[1]==='rm'){delete s.networks[a.at(-1)];save();}` +
        `else{save();}`,
      { mode: 0o755 },
    );
    await chmod(runtime, 0o755);
    const binding = { provider: "podman" as const, executable: runtime, socket: join(root, "fake.sock") };
    const env = { ...process.env, STATE_FILE: statePath };
    const ids = ["owned-network", "foreign-network", "array-labels", "missing-labels", "non-string-label"];
    await forceRemoveOwnedResources(context, binding, env, new LifecycleLedger(), {
      containers: [],
      networks: ids,
      volumes: [],
      images: [],
    });
    const guarded = JSON.parse(await readFile(statePath, "utf8")) as typeof initial;
    expect(Object.keys(guarded.networks).sort()).toEqual([
      "array-labels",
      "foreign-network",
      "missing-labels",
      "non-string-label",
    ]);
    expect(guarded.commands.some((args) => args.join(" ") === "network rm owned-network")).toBe(true);
    for (const id of ["foreign-network", "array-labels", "missing-labels", "non-string-label"]) {
      expect(guarded.commands.some((args) => args.join(" ") === `network rm ${id}`)).toBe(false);
    }
    for (const id of ids) {
      expect(guarded.commands.some((args) => args.join(" ") === `network inspect ${id}`)).toBe(true);
    }
  });
});
