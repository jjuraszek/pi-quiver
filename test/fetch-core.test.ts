import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { formatSize as piFormatSize } from "@earendil-works/pi-coding-agent";
import { fetchUrl, formatSize, executeGhRouting } from "../lib/fetch-core.ts";

function serve(handler: Parameters<typeof createServer>[1]) {
	const server = createServer(handler);
	return new Promise<{ url: string; close: () => void }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => {
					server.closeAllConnections();
					server.close();
				},
			});
		});
	});
}

test("formatSize is byte-identical to pi's", () => {
	for (const n of [0, 1, 512, 1023, 1024, 1536, 1024 * 1024 - 1, 1024 * 1024, 5_500_000, 50_000_000]) {
		assert.strictEqual(formatSize(n), piFormatSize(n));
	}
});

test("fetchUrl: HEAD returns headers only", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("body ignored");
	});
	try {
		const r = await fetchUrl({ url: `${srv.url}/`, method: "HEAD" });
		assert.match(r.output, /HTTP 200/);
		assert.match(r.output, /Length: 0 \(no body\)/);
		assert.strictEqual(r.details.bytes, 0);
	} finally { srv.close(); }
});

test("fetchUrl: 404 and 500 are results, not errors", async () => {
	for (const status of [404, 500]) {
		const srv = await serve((_req, res) => {
			res.writeHead(status, { "content-type": "text/plain" });
			res.end("err body");
		});
		try {
			const r = await fetchUrl({ url: `${srv.url}/` });
			assert.match(r.output, new RegExp(`HTTP ${status}`));
			assert.strictEqual(r.details.status, status);
		} finally { srv.close(); }
	}
});

test("fetchUrl: large text spills to file with preview", async () => {
	const big = "line of text\n".repeat(5000); // > 32KB and > 1000 lines
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(big);
	});
	try {
		const r = await fetchUrl({ url: `${srv.url}/` });
		assert.strictEqual(r.details.spilled, true);
		assert.ok(r.details.file);
		assert.match(r.output, /written to file \(too large to inline\)/);
		assert.match(readFileSync(r.details.file!, "utf8"), /^line of text/);
	} finally { srv.close(); }
});

test("fetchUrl: >1MB body is truncated, still exit-0-shaped", async () => {
	const huge = Buffer.alloc(1_500_000, 0x61); // 'a' x 1.5MB
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(huge);
	});
	try {
		const r = await fetchUrl({ url: `${srv.url}/` });
		assert.strictEqual(r.details.truncated, true);
		assert.match(r.output, /truncated to 1MB/);
	} finally { srv.close(); }
});

test("fetchUrl: mid-flight abort rejects (HTTP path)", async () => {
	let pendingTimer: NodeJS.Timeout | undefined;
	const srv = await serve((_req, res) => {
		pendingTimer = setTimeout(() => res.end("late"), 5000);
	});
	try {
		const controller = new AbortController();
		const pending = assert.rejects(fetchUrl({ url: `${srv.url}/`, signal: controller.signal }));
		setTimeout(() => controller.abort(), 100);
		await pending;
	} finally {
		clearTimeout(pendingTimer);
		srv.close();
	}
});

test("executeGhRouting: signal reaches the runner (gh path)", async () => {
	let seen: AbortSignal | undefined;
	const controller = new AbortController();
	const r = await executeGhRouting(
		{}, new URL("https://github.com/o/r/issues/1"), controller.signal,
		async (_args, _t, signal) => { seen = signal; return { ok: true, stdout: "gh says hi" }; },
	);
	assert.strictEqual(seen, controller.signal);
	assert.match(r!.output, /gh says hi/);
});

test("fetchUrl: unsupported protocol throws", async () => {
	await assert.rejects(fetchUrl({ url: "ftp://example.com/x" }), /Unsupported protocol/);
});
