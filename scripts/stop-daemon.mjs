import { health, readInstance, rpc } from "./daemon-control.mjs";

const instance = await readInstance();
if (!instance || !(await health(instance))) {
  console.log(JSON.stringify({ running: false, stopped: false }, null, 2));
  process.exit(0);
}
await rpc(instance, "shutdown");
console.log(JSON.stringify({ stopped: true, instanceId: instance.instanceId, pid: instance.pid }, null, 2));
