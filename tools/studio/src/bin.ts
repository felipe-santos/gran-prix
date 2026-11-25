#!/usr/bin/env node
import { main } from "./server/cli.js";

const r = await main(process.argv.slice(2), {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  cwd: process.cwd(),
});
if (typeof r === "number") process.exitCode = r;
else {
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void r.close().then(() => process.exit(0)));
}
