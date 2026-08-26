import { test } from "node:test";
import assert from "node:assert";
import { parseCliArgs } from "../bin/pi-quiver.ts";

test("parseCliArgs: minimal fetch", () => {
	const r = parseCliArgs(["fetch", "https://example.com"]);
	assert.deepStrictEqual(r, { ok: true, cmd: "fetch", opts: { url: "https://example.com" } });
});

test("parseCliArgs: full flags", () => {
	const r = parseCliArgs([
		"fetch", "https://example.com", "--method", "POST",
		"--header", "X-A: 1", "--header", "Authorization: Bearer a:b",
		"--body", "hi", "--raw", "--timeout-ms", "5000",
	]);
	assert.deepStrictEqual(r, {
		ok: true,
		cmd: "fetch",
		opts: {
			url: "https://example.com", method: "POST",
			headers: { "X-A": "1", "Authorization": "Bearer a:b" },
			body: "hi", raw: true, timeoutMs: 5000,
		},
	});
});

test("parseCliArgs: duplicate header keys - last wins", () => {
	const r = parseCliArgs(["fetch", "https://x.dev", "--header", "K: a", "--header", "K: b"]);
	assert.ok(r.ok && r.cmd === "fetch");
	assert.deepStrictEqual(r.opts.headers, { K: "b" });
});

test("parseCliArgs: usage errors exit-2 shape", () => {
	for (const argv of [
		[], ["nope", "https://x.dev"], ["fetch"], ["fetch", "https://x.dev", "--method", "PUT"],
		["fetch", "https://x.dev", "--header", "no-colon-space"],
		["fetch", "https://x.dev", "--timeout-ms", "abc"],
		["fetch", "https://x.dev", "--timeout-ms", "-1"],
		["fetch", "https://x.dev", "--wat"],
		["fetch", "https://x.dev", "extra-positional"],
	]) {
		const r = parseCliArgs(argv);
		assert.strictEqual(r.ok, false, JSON.stringify(argv));
		assert.ok(!r.ok && r.error.length > 0);
	}
});

test("parseCliArgs: no headers leaves headers undefined (gh routing stays live)", () => {
	const r = parseCliArgs(["fetch", "https://github.com/o/r/issues/1"]);
	assert.ok(r.ok && r.cmd === "fetch");
	assert.strictEqual(r.opts.headers, undefined);
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/pi-quiver.ts", import.meta.url));

function serve(handler: Parameters<typeof createServer>[1]) {
	const server = createServer(handler);
	return new Promise<{ url: string; close: () => void }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
		});
	});
}

test("CLI subprocess: 200 text -> stdout, exit 0", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("hello quiver");
	});
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "fetch", `${srv.url}/`]);
		assert.match(stdout, /HTTP 200/);
		assert.match(stdout, /hello quiver/);
	} finally { srv.close(); }
});

test("CLI subprocess: 404 is still exit 0 with HTTP 404 in output", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("nope");
	});
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "fetch", `${srv.url}/`]);
		assert.match(stdout, /HTTP 404/);
	} finally { srv.close(); }
});

test("CLI subprocess: >1MB body -> truncated, spilled to file, exit 0", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(Buffer.alloc(1_500_000, 0x61));
	});
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			[BIN, "fetch", `${srv.url}/`],
			{ maxBuffer: 10 * 1024 * 1024 },
		);
		assert.match(stdout, /HTTP 200/);
		assert.match(stdout, /truncated to 1MB/);
		assert.match(stdout, /written to file \(too large to inline\)/);
	} finally { srv.close(); }
});

test("CLI subprocess: connection refused -> exit 1", async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [BIN, "fetch", "http://127.0.0.1:1/"]),
		(err: { code?: number; stderr?: string }) => err.code === 1 && /fetch failed/.test(err.stderr ?? ""),
	);
});

test("CLI subprocess: usage error -> exit 2", async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [BIN, "fetch"]),
		(err: { code?: number; stderr?: string }) => err.code === 2 && /Usage:/.test(err.stderr ?? ""),
	);
});

test("CLI subprocess: runs via symlinked entry (npm .bin shape)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-symlink-"));
	try {
		const link = join(dir, "pi-quiver");
		try { symlinkSync(BIN, link); } catch { t.skip("symlink not permitted"); return; }
		await assert.rejects(
			execFileAsync(process.execPath, [link, "fetch"]),
			(err: { code?: number; stderr?: string }) => err.code === 2 && /Usage:/.test(err.stderr ?? ""),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
