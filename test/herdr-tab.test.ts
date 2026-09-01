import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getTab, herdrRequest, isHerdrActive, listTabs, renameTab } from "../lib/herdr-tab.ts";

let pipeCounter = 0;

// Returns the value to pass as socketPath to the code under test. Production
// prefixes \\.\pipe\ on win32, so the fake server listens on the prefixed
// name while the bare name is handed to the client.
function mintSocketPath(dir: string): { clientPath: string; listenPath: string } {
	if (process.platform === "win32") {
		const name = `pi-quiver-herdr-test-${process.pid}-${pipeCounter++}`;
		return { clientPath: name, listenPath: `\\\\.\\pipe\\${name}` };
	}
	const p = join(dir, "herdr.sock");
	return { clientPath: p, listenPath: p };
}

type Responder = (msg: { id: string; method: string; params: Record<string, unknown> }) => unknown;

async function withFakeHerdr(
	respond: Responder,
	fn: (clientPath: string) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "herdr-tab-test-"));
	const { clientPath, listenPath } = mintSocketPath(dir);
	const server = net.createServer((conn) => {
		let buf = "";
		conn.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const msg = JSON.parse(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
				const res = respond(msg);
				if (res !== undefined) conn.write(`${JSON.stringify(res)}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(listenPath, resolve));
	try {
		await fn(clientPath);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
}

test("isHerdrActive: all present + TTY -> true; each gate missing -> false", () => {
	const full = { HERDR_ENV: "1", HERDR_TAB_ID: "w1:t1", HERDR_SOCKET_PATH: "/tmp/h.sock" };
	assert.equal(isHerdrActive(full, true), true);
	assert.equal(isHerdrActive(full, false), false);
	assert.equal(isHerdrActive({ ...full, HERDR_ENV: "0" }, true), false);
	assert.equal(isHerdrActive({ ...full, HERDR_ENV: undefined }, true), false);
	assert.equal(isHerdrActive({ ...full, HERDR_TAB_ID: "" }, true), false);
	assert.equal(isHerdrActive({ ...full, HERDR_SOCKET_PATH: undefined }, true), false);
});

test("herdrRequest: success envelope returns result; string id; newline framing", async () => {
	await withFakeHerdr(
		(msg) => {
			assert.equal(typeof msg.id, "string");
			assert.equal(msg.method, "tab.get");
			return { id: msg.id, result: { type: "tab_info", tab: { tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1 } } };
		},
		async (sock) => {
			const result = await herdrRequest(sock, "tab.get", { tab_id: "w1:t1" });
			assert.deepEqual((result as { tab: { label: string } }).tab.label, "1");
		},
	);
});

test("herdrRequest: error response resolves null", async () => {
	await withFakeHerdr(
		(msg) => ({ id: (msg as { id: string }).id, error: { code: "not_found", message: "no such tab" } }),
		async (sock) => {
			assert.equal(await herdrRequest(sock, "tab.get", { tab_id: "w9:t9" }), null);
		},
	);
});

test("herdrRequest: malformed response line resolves null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-tab-test-"));
	const { clientPath, listenPath } = mintSocketPath(dir);
	const server = net.createServer((conn) => {
		conn.on("data", () => conn.write("not json at all\n"));
	});
	await new Promise<void>((resolve) => server.listen(listenPath, resolve));
	try {
		assert.equal(await herdrRequest(clientPath, "tab.get", {}), null);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});

test("herdrRequest: unreachable socket resolves null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-tab-test-"));
	try {
		assert.equal(await herdrRequest(join(dir, "absent.sock"), "tab.get", {}), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("herdrRequest: silent server hits timeout and resolves null", async () => {
	await withFakeHerdr(
		() => undefined, // never respond
		async (sock) => {
			const started = Date.now();
			assert.equal(await herdrRequest(sock, "tab.get", {}, 200), null);
			assert.ok(Date.now() - started < 1500, "returned at the short timeout, not the default");
		},
	);
});

test("getTab/listTabs/renameTab resolve null on error envelope", async () => {
	await withFakeHerdr(
		(msg) => ({ id: msg.id, error: { code: "not_found", message: "gone" } }),
		async (sock) => {
			assert.equal(await getTab(sock, "w1:t2"), null);
			assert.equal(await listTabs(sock), null);
			assert.equal(await renameTab(sock, "w1:t2", "New label"), null);
		},
	);
});

test("getTab/listTabs resolve null when result is present but the expected field is missing/malformed", async () => {
	await withFakeHerdr(
		(msg) => {
			if (msg.method === "tab.get") return { id: msg.id, result: { type: "tab_info" } };
			if (msg.method === "tab.list") return { id: msg.id, result: { type: "tab_list", tabs: "nope" } };
			throw new Error(`unexpected method ${msg.method}`);
		},
		async (sock) => {
			assert.equal(await getTab(sock, "w1:t2"), null);
			assert.equal(await listTabs(sock), null);
		},
	);
});

test("getTab/listTabs/renameTab unwrap the nested envelope", async () => {
	const tab = { tab_id: "w1:t2", workspace_id: "w1", label: "2", number: 2 };
	await withFakeHerdr(
		(msg) => {
			if (msg.method === "tab.get") return { id: msg.id, result: { type: "tab_info", tab } };
			if (msg.method === "tab.list") return { id: msg.id, result: { type: "tab_list", tabs: [tab] } };
			if (msg.method === "tab.rename") {
				assert.deepEqual(msg.params, { tab_id: "w1:t2", label: "New label" });
				return { id: msg.id, result: { type: "tab_info", tab: { ...tab, label: "New label" } } };
			}
			throw new Error(`unexpected method ${msg.method}`);
		},
		async (sock) => {
			assert.deepEqual(await getTab(sock, "w1:t2"), tab);
			assert.deepEqual(await listTabs(sock), [tab]);
			assert.equal(await renameTab(sock, "w1:t2", "New label"), true);
		},
	);
});
