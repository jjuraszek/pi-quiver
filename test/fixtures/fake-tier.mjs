// Scripted child for orchestration tests. argv[2] = mode (ignored), options JSON on stdin.
// Options: { script: { sleepMs, exit, stdout, stageImages: [{page, files, done}], spawnGrandchild, bigStdout } }
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const o = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const s = o.script ?? {};
for (const st of s.stageImages ?? []) {
	const d = join(o.stagingDir, `p${st.page}`);
	mkdirSync(d, { recursive: true });
	for (const f of st.files) writeFileSync(join(d, f), "img");
	if (st.done) writeFileSync(join(d, ".done"), "");
}
if (s.spawnGrandchild) {
	const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	process.stderr.write(`grandchild=${gc.pid}\n`);
}
if (s.sleepMs) await new Promise((r) => setTimeout(r, s.sleepMs));
if (s.bigStdout) process.stdout.write("x".repeat(s.bigStdout));
else if (s.stdout !== undefined) process.stdout.write(typeof s.stdout === "string" ? s.stdout : JSON.stringify(s.stdout));
process.exitCode = s.exit ?? 0;
