import { parseCliArgs, runSlack } from "../../bin/pi-quiver.ts";

const calls = [];
let stdout = "", stderr = "";
const parsed = parseCliArgs(process.argv.slice(2));
let code;
if (!parsed.ok) {
	code = 2;
	stderr = `usage: ${parsed.error}\n`;
} else {
	if (parsed.cmd !== "slack") throw new Error("harness expects a Slack mutation");
	code = await runSlack(parsed, {
		env: process.env,
		cwd: process.cwd(),
		stdout: (text) => { stdout += text; },
		stderr: (text) => { stderr += text; },
		apiCall: async (method, _token, params) => {
			calls.push({ method, params });
			if (method === "chat.postMessage") return { ts: "100.1" };
			if (method === "chat.getPermalink") return { permalink: "https://example.test/message" };
			throw new Error(`unexpected method: ${method}`);
		},
		uploadBytes: async () => { throw new Error("unexpected upload"); },
	});
}
process.stdout.write(JSON.stringify({ code, stdout, stderr, calls }));
process.exitCode = code;
