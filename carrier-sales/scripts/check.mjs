import { spawnSync } from "node:child_process";

const commands = [
  ["node_modules/eslint/bin/eslint.js", ".", "--max-warnings", "0"],
  ["node_modules/next/dist/bin/next", "typegen"],
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["node_modules/vitest/vitest.mjs", "run"],
  ["node_modules/next/dist/bin/next", "build"],
  ["scripts/prepare-standalone.mjs"],
];

for (const [entrypoint, ...args] of commands) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
