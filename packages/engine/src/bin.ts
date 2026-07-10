#!/usr/bin/env node
/** The `pacioli` executable — a thin process wrapper; all logic lives in cli.ts. */
import { runCli } from "./cli";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  readStdin,
}).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`pacioli: unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(2);
  },
);
