import { readFile, readdir, rename, writeFile } from "node:fs/promises";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!/^[a-z0-9-]+$/i.test(target)) throw new Error(`Invalid release target: ${target}`);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packedName = (await readdir(process.cwd())).find(
  name => name === `${packageJson.name}-${packageJson.version}.tgz`
);
if (!packedName) throw new Error(`npm pack output not found for ${packageJson.name}@${packageJson.version}`);

const assetName = `${packageJson.name}-${packageJson.version}-${target}.tgz`;
await rename(packedName, assetName);
await writeFile("release-asset-name.txt", `${assetName}\n`);
process.stdout.write(`${assetName}\n`);
