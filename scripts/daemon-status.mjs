import { health, readInstance } from "./daemon-control.mjs";

const instance = await readInstance();
const snapshot = instance && await health(instance);
if (!instance || !snapshot) {
  console.log(JSON.stringify({ running: false }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ running: true, instance, health: snapshot }, null, 2));
