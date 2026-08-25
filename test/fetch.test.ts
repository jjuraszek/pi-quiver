import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { categorize, htmlToMarkdown, prettyJson, applyGate, collectBody, binaryExtension, classifyGitHubTarget, buildGhArgs, buildGhLogArgs, planGhRouting, executeGhRouting } from "../lib/fetch-core.ts";

const empty = Buffer.alloc(0);
const withNul = Buffer.from([0x68, 0x00, 0x69]); // "h\0i"

test("categorize: html → markdown, raw forces text", () => {
	assert.equal(categorize("text/html; charset=utf-8", empty, false), "markdown");
	assert.equal(categorize("text/html", empty, true), "text");
	assert.equal(categorize("application/xhtml+xml", empty, false), "markdown");
});

test("categorize: raw=true skips JSON pretty-print (→ text), never overrides binary", () => {
	assert.equal(categorize("application/json", empty, true), "text");
	assert.equal(categorize("application/ld+json", empty, true), "text");
	assert.equal(categorize("image/png", empty, true), "binary"); // binary not overridden by raw
	assert.equal(categorize("application/octet-stream", withNul, true), "binary"); // NUL detection not overridden
});

test("categorize: json variants → json", () => {
	assert.equal(categorize("application/json", empty, false), "json");
	assert.equal(categorize("application/ld+json", empty, false), "json");
});

test("categorize: xml/text/js → text", () => {
	assert.equal(categorize("application/xml", empty, false), "text");
	assert.equal(categorize("application/atom+xml", empty, false), "text");
	assert.equal(categorize("text/plain", empty, false), "text");
	assert.equal(categorize("application/javascript", empty, false), "text");
});

test("categorize: images (incl svg) → binary", () => {
	assert.equal(categorize("image/png", empty, false), "binary");
	assert.equal(categorize("image/svg+xml", empty, false), "binary");
});

test("categorize: known binary → binary", () => {
	assert.equal(categorize("application/pdf", empty, false), "binary");
	assert.equal(categorize("application/zip", empty, false), "binary");
});

test("categorize: octet-stream / empty / unknown decided by NUL sniff", () => {
	assert.equal(categorize("application/octet-stream", empty, false), "text");
	assert.equal(categorize("application/octet-stream", withNul, false), "binary");
	assert.equal(categorize("", empty, false), "text");
	assert.equal(categorize("application/x-unknown-thing", empty, false), "text");
});

test("categorize: NUL byte downgrades a text candidate to binary", () => {
	assert.equal(categorize("text/html", withNul, false), "binary");
	assert.equal(categorize("application/json", withNul, false), "binary");
});

test("htmlToMarkdown: article structure preserved", () => {
	const body = "<p>" + "Readability needs a few hundred characters of real prose before it treats a node as the main article body, so this paragraph is deliberately long and repetitive to clear the default character threshold. ".repeat(4) + "</p>";
	const html = `<!doctype html><html><head><title>My Title</title></head><body><article><h2>Section</h2>${body}<ul><li>first</li><li>second</li></ul><pre><code>const x = 1;</code></pre><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></article></body></html>`;
	const md = htmlToMarkdown(html, "https://example.com/post");
	assert.ok(md, "expected markdown, got null");
	assert.match(md!, /^# My Title/);
	assert.match(md!, /## Section/);
	assert.match(md!, /-\s+first/); // turndown emits `-   first` (3 spaces); tolerate any whitespace
	assert.match(md!, /\| A \| B \|/);
	assert.match(md!, /```/);
});

test("htmlToMarkdown: unparseable / empty → null", () => {
	// Empty body: readability finds no extractable content → null
	assert.equal(htmlToMarkdown("<html><body></body></html>", "https://example.com"), null);
	// Empty string: JSDOM creates an empty document → null
	assert.equal(htmlToMarkdown("", "https://example.com"), null);
});

test("prettyJson: valid is indented, invalid is passthrough", () => {
	assert.equal(prettyJson('{"a":1,"b":[2,3]}'), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
	assert.equal(prettyJson("not json"), "not json");
});

test("applyGate: boundaries at 32 KB / 1000 lines", () => {
	assert.equal(applyGate("").spill, false);
	assert.equal(applyGate("small").spill, false);
	assert.equal(applyGate("x".repeat(32_001)).spill, true);
	assert.equal(applyGate(Array(1001).fill("y").join("\n")).spill, true);
	const r = applyGate("a\nb\nc");
	assert.equal(r.lines, 3);
	assert.equal(r.bytes, 5);
});

// --- collectBody integration tests (no network; uses Response with in-memory body) ---

function makeResponse(body: Uint8Array | string, contentType: string): Response {
	// Buffer is Uint8Array<ArrayBuffer> in Node types, satisfying BodyInit's strict generic
	const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
	return new Response(bytes, { headers: { "content-type": contentType } });
}

test("collectBody: text/plain → text category, buffer defined, not truncated", async () => {
	const res = makeResponse("hello world", "text/plain");
	const ct = res.headers.get("content-type") ?? "";
	const result = await collectBody(res, ct, false);
	assert.equal(result.category, "text");
	assert.ok(result.buffer, "buffer should be defined");
	assert.equal(result.truncated, false);
	assert.equal(result.file, undefined);
});

test("collectBody: application/json → json category", async () => {
	const res = makeResponse('{"x":1}', "application/json");
	const ct = res.headers.get("content-type") ?? "";
	const result = await collectBody(res, ct, false);
	assert.equal(result.category, "json");
	assert.ok(result.buffer);
	assert.equal(result.truncated, false);
});

test("collectBody: text/html + raw=false → markdown; raw=true → text", async () => {
	const html = "<html><head><title>T</title></head><body><p>hello</p></body></html>";
	const res1 = makeResponse(html, "text/html");
	const ct = res1.headers.get("content-type") ?? "";
	const r1 = await collectBody(res1, ct, false);
	assert.equal(r1.category, "markdown");

	const res2 = makeResponse(html, "text/html");
	const r2 = await collectBody(res2, ct, true);
	assert.equal(r2.category, "text");
});

test("collectBody: image/png → binary, file written to disk, content matches", async () => {
	// PNG magic bytes
	const magic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const res = makeResponse(magic, "image/png");
	const ct = res.headers.get("content-type") ?? "";
	const result = await collectBody(res, ct, false);
	assert.equal(result.category, "binary");
	assert.equal(result.buffer, undefined);
	assert.ok(result.file, "file path should be defined");
	assert.ok(existsSync(result.file!), "file should exist on disk");
	const written = readFileSync(result.file!);
	assert.deepEqual(written, Buffer.from(magic));
	rmSync(result.file!);
});

test("collectBody: text truncation at 1MB — truncated=true, buffer capped", async () => {
	const PARSABLE_MAX = 1_000_000;
	const oversized = "a".repeat(PARSABLE_MAX + 50_000);
	const res = makeResponse(oversized, "text/plain");
	const ct = res.headers.get("content-type") ?? "";
	const result = await collectBody(res, ct, false);
	assert.equal(result.truncated, true);
	assert.equal(result.category, "text");
	assert.ok(result.buffer);
	assert.equal(result.buffer!.length, PARSABLE_MAX);
});

test("binaryExtension: OOXML office types map to docx/pptx (fetch->doc_to_md chain)", () => {
	assert.equal(binaryExtension("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
	assert.equal(binaryExtension("application/vnd.openxmlformats-officedocument.presentationml.presentation"), "pptx");
	assert.equal(binaryExtension("application/pdf"), "pdf");
});

test("classifyGitHubTarget: issue / pr / repo shapes", () => {
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/jjuraszek/pi-quiver/issues/1")), { kind: "issue", url: "https://github.com/jjuraszek/pi-quiver/issues/1" });
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/jjuraszek/pi-quiver/pull/42")), { kind: "pr", url: "https://github.com/jjuraszek/pi-quiver/pull/42" });
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/jjuraszek/pi-quiver")), { kind: "repo", slug: "jjuraszek/pi-quiver" });
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/jjuraszek/pi-quiver/")), { kind: "repo", slug: "jjuraszek/pi-quiver" });
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/jjuraszek/pi-condense/actions/runs/28867698934")), { kind: "run", slug: "jjuraszek/pi-condense", runId: "28867698934", url: "https://github.com/jjuraszek/pi-condense/actions/runs/28867698934" });
});

test("classifyGitHubTarget: job URL (singular /job/<id>)", () => {
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/gridstrong/gridstrong/actions/runs/32817046112/job/97707339063")), {
		kind: "job", slug: "gridstrong/gridstrong", jobId: "97707339063",
		url: "https://github.com/gridstrong/gridstrong/actions/runs/32817046112/job/97707339063",
	});
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/o/r/actions/runs/1/job/2?pr=3#step:5:10")), {
		kind: "job", slug: "o/r", jobId: "2", url: "https://github.com/o/r/actions/runs/1/job/2",
	});
});

test("classifyGitHubTarget: job-adjacent non-matches → null", () => {
	for (const u of [
		"https://github.com/o/r/actions/runs/1/job/notanumber",
		"https://github.com/o/r/actions/runs/notanumber/job/2",
		"https://github.com/o/r/actions/runs/1/job",
		"https://github.com/o/r/actions/runs/1/attempts/2/job/3",
		"https://github.com/o/r/actions/runs/1/job/2/extra",
	]) {
		assert.equal(classifyGitHubTarget(new URL(u)), null, u);
	}
});

test("buildGhArgs: job maps to run view --job", () => {
	assert.deepEqual(buildGhArgs({ kind: "job", slug: "o/r", jobId: "7", url: "https://github.com/o/r/actions/runs/1/job/7" }), ["run", "view", "--job", "7", "--repo", "o/r"]);
});

test("buildGhLogArgs: run/job get --log-failed argv, others null", () => {
	assert.deepEqual(buildGhLogArgs({ kind: "run", slug: "o/r", runId: "99", url: "https://github.com/o/r/actions/runs/99" }), ["run", "view", "99", "--log-failed", "--repo", "o/r"]);
	assert.deepEqual(buildGhLogArgs({ kind: "job", slug: "o/r", jobId: "7", url: "https://github.com/o/r/actions/runs/1/job/7" }), ["run", "view", "--job", "7", "--log-failed", "--repo", "o/r"]);
	assert.equal(buildGhLogArgs({ kind: "issue", url: "https://github.com/o/r/issues/1" }), null);
	assert.equal(buildGhLogArgs({ kind: "pr", url: "https://github.com/o/r/pull/2" }), null);
	assert.equal(buildGhLogArgs({ kind: "repo", slug: "o/r" }), null);
});

test("classifyGitHubTarget: strips query + fragment, accepts www host", () => {
	assert.deepEqual(classifyGitHubTarget(new URL("https://github.com/o/r/issues/7?foo=bar#issuecomment-99")), { kind: "issue", url: "https://github.com/o/r/issues/7" });
	assert.deepEqual(classifyGitHubTarget(new URL("https://www.github.com/o/r/pull/8#discussion")), { kind: "pr", url: "https://github.com/o/r/pull/8" });
});

test("classifyGitHubTarget: non-matches \u2192 null", () => {
	for (const u of [
		"https://github.com/o/r/tree/main",
		"https://github.com/o/r/blob/main/x.ts",
		"https://github.com/o/r/releases/tag/v1",
		"https://github.com/o/r/issues/notanumber",
		"https://github.com/o/r/actions/runs/notanumber",
		"https://github.com/o/r/actions/workflows/test.yml",
		"https://github.com/o/r/actions/runs/123/jobs/456",
		"https://github.com/o",
		"https://github.example.com/o/r/issues/1",
		"https://raw.githubusercontent.com/o/r/main/x",
		"https://gist.github.com/o/abc123",
		"https://github.com/orgs/some-org",
		"https://github.com/trending/rust",
		"https://github.com/o/r spaces/issues/1",
		"https://github.com/orgs/foo/issues/5",
		"https://github.com/users/bar/pull/9",
		"https://github.com/orgs/x",
		"https://github.com/users/x",
		"https://github.com/sponsors/x",
		"https://github.com/topics/x",
		"https://github.com/marketplace/x",
		"https://github.com/apps/x",
		"https://github.com/collections/x",
		"https://github.com/stars/x",
		"https://github.com/settings/x",
		"https://github.com/notifications/x",
		"https://github.com/codespaces/x",
		"https://github.com/features/x",
		"https://github.com/trending/x",
		"https://github.com/security/x",
		"https://github.com/customer-stories/x",
	]) {
		assert.equal(classifyGitHubTarget(new URL(u)), null, u);
	}
});

test("buildGhArgs: three shapes map to exact arg arrays", () => {
	assert.deepEqual(buildGhArgs({ kind: "issue", url: "https://github.com/o/r/issues/1" }), ["issue", "view", "https://github.com/o/r/issues/1", "--comments"]);
	assert.deepEqual(buildGhArgs({ kind: "pr", url: "https://github.com/o/r/pull/2" }), ["pr", "view", "https://github.com/o/r/pull/2", "--comments"]);
	assert.deepEqual(buildGhArgs({ kind: "repo", slug: "o/r" }), ["repo", "view", "o/r"]);
	assert.deepEqual(buildGhArgs({ kind: "run", slug: "o/r", runId: "99", url: "https://github.com/o/r/actions/runs/99" }), ["run", "view", "99", "--repo", "o/r"]);
});

test("planGhRouting: routes a bare issue URL, bypasses on HTTP-specific intent", () => {
	const u = new URL("https://github.com/o/r/issues/1");
	assert.deepEqual(planGhRouting({}, u), { kind: "issue", url: "https://github.com/o/r/issues/1" });
	assert.equal(planGhRouting({ raw: true }, u), null);
	assert.equal(planGhRouting({ method: "POST" }, u), null);
	assert.equal(planGhRouting({ body: "x" }, u), null);
	assert.equal(planGhRouting({ headers: { "x-foo": "1" } }, u), null);
	assert.deepEqual(planGhRouting({ headers: {} }, u), { kind: "issue", url: "https://github.com/o/r/issues/1" });
});

test("executeGhRouting: success renders gh result; failure falls through (null)", async () => {
	const okRunner = async () => ({ ok: true as const, stdout: "# Issue title\n\nbody text\n" });
	const okResult = await executeGhRouting({}, new URL("https://github.com/o/r/issues/1"), undefined, okRunner);
	assert.ok(okResult, "expected a result");
	assert.equal(okResult!.details.via, "gh");
	assert.equal(okResult!.details.ghCommand, "issue view --comments");
	assert.equal(okResult!.details.category, "markdown");
	assert.equal(okResult!.details.status, undefined);
	assert.ok(okResult!.output.startsWith("Source: gh issue view https://github.com/o/r/issues/1 --comments"));

	const failRunner = async () => ({ ok: false as const });
	const failResult = await executeGhRouting({}, new URL("https://github.com/o/r/issues/1"), undefined, failRunner);
	assert.equal(failResult, null);

	const missResult = await executeGhRouting({}, new URL("https://github.com/o/r/tree/main"), undefined, okRunner);
	assert.equal(missResult, null, "non-matching URL must not invoke routing");
});

test("executeGhRouting: large gh output spills to a file", async () => {
	const big = ("line\n").repeat(1100);
	const runner = async () => ({ ok: true as const, stdout: big });
	const result = await executeGhRouting({}, new URL("https://github.com/o/r/pull/2"), undefined, runner);
	assert.ok(result);
	assert.equal(result!.details.spilled, true);
	assert.ok(result!.details.file, "expected a spill file path");
	assert.ok(existsSync(result!.details.file!));
	assert.ok(result!.output.includes("Saved-To:"));
	rmSync(result!.details.file!);
});

test("executeGhRouting: job URL makes summary + --log-failed calls, appends logs", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		if (args.includes("--log-failed")) return { ok: true as const, stdout: "##[error]assertion failed\n" };
		return { ok: true as const, stdout: "X Run tests\n" };
	};
	const result = await executeGhRouting({}, new URL("https://github.com/o/r/actions/runs/1/job/7"), undefined, runner);
	assert.ok(result);
	assert.deepEqual(calls, [
		["run", "view", "--job", "7", "--repo", "o/r"],
		["run", "view", "--job", "7", "--log-failed", "--repo", "o/r"],
	]);
	assert.ok(result!.output.includes("Source: gh run view --job 7 --repo o/r"));
	assert.ok(result!.output.includes("Source: gh run view --job 7 --log-failed --repo o/r"));
	assert.ok(result!.output.includes("## Failed step logs"));
	assert.ok(result!.output.includes("##[error]assertion failed"));
	assert.equal(result!.details.ghCommand, "run view --job");
	assert.equal(result!.details.url, "https://github.com/o/r/actions/runs/1/job/7");
});

test("executeGhRouting: run URL also gets the --log-failed call", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		if (args.includes("--log-failed")) return { ok: true as const, stdout: "log line\n" };
		return { ok: true as const, stdout: "summary\n" };
	};
	const result = await executeGhRouting({}, new URL("https://github.com/o/r/actions/runs/99"), undefined, runner);
	assert.ok(result);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], ["run", "view", "99", "--log-failed", "--repo", "o/r"]);
	assert.ok(result!.output.includes("## Failed step logs"));
});

test("executeGhRouting: failed/empty log call degrades to summary-only", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		if (args.includes("--log-failed")) return { ok: false as const };
		return { ok: true as const, stdout: "summary\n" };
	};
	const result = await executeGhRouting({}, new URL("https://github.com/o/r/actions/runs/1/job/7"), undefined, runner);
	assert.ok(result);
	assert.equal(calls.length, 2);
	assert.ok(!result!.output.includes("## Failed step logs"));
	assert.equal(result!.output.match(/^Source: /gm)!.length, 1);
});

test("executeGhRouting: ok-but-empty log call degrades to summary-only", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		if (args.includes("--log-failed")) return { ok: true as const, stdout: "" };
		return { ok: true as const, stdout: "summary\n" };
	};
	const result = await executeGhRouting({}, new URL("https://github.com/o/r/actions/runs/1/job/7"), undefined, runner);
	assert.ok(result);
	assert.equal(calls.length, 2);
	assert.ok(!result!.output.includes("## Failed step logs"));
	assert.equal(result!.output.match(/^Source: /gm)!.length, 1);
});

test("executeGhRouting: issue target stays single-call", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		return { ok: true as const, stdout: "body\n" };
	};
	await executeGhRouting({}, new URL("https://github.com/o/r/issues/1"), undefined, runner);
	assert.equal(calls.length, 1);
});

test("executeGhRouting: PR target stays single-call", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		return { ok: true as const, stdout: "body\n" };
	};
	await executeGhRouting({}, new URL("https://github.com/o/r/pull/2"), undefined, runner);
	assert.equal(calls.length, 1);
});

test("executeGhRouting: repo target stays single-call", async () => {
	const calls: string[][] = [];
	const runner = async (args: string[]) => {
		calls.push(args);
		return { ok: true as const, stdout: "repo info\n" };
	};
	await executeGhRouting({}, new URL("https://github.com/o/r"), undefined, runner);
	assert.equal(calls.length, 1);
});

test("executeGhRouting: large summary+logs body spills as one gated body", async () => {
	const runner = async (args: string[]) => {
		if (args.includes("--log-failed")) return { ok: true as const, stdout: "LOGPAYLOAD\n".repeat(600) };
		return { ok: true as const, stdout: "SUMMARYMARK\n".repeat(600) };
	};
	const result = await executeGhRouting({}, new URL("https://github.com/o/r/actions/runs/1/job/7"), undefined, runner);
	assert.ok(result);
	assert.equal(result!.details.spilled, true);
	assert.ok(result!.output.includes("Source: gh run view --job 7 --repo o/r"));
	assert.ok(result!.output.includes("Source: gh run view --job 7 --log-failed --repo o/r"));
	const spilled = readFileSync(result!.details.file!, "utf8");
	assert.ok(spilled.includes("SUMMARYMARK"));
	assert.ok(spilled.includes("LOGPAYLOAD"));
	assert.equal(spilled.match(/^## Failed step logs$/gm)!.length, 1);
	rmSync(result!.details.file!);
});

test("executeGhRouting: abort during the log call rejects, never summary-only", async () => {
	const ac = new AbortController();
	const reason = new Error("user aborted");
	const runner = async (args: string[]) => {
		if (args.includes("--log-failed")) {
			ac.abort(reason);
			return { ok: false as const };
		}
		return { ok: true as const, stdout: "summary\n" };
	};
	await assert.rejects(
		executeGhRouting({}, new URL("https://github.com/o/r/actions/runs/1/job/7"), ac.signal, runner),
		/user aborted/,
	);
});

test("executeGhRouting: abort during the summary call rejects, never HTTP fallback", async () => {
	const ac = new AbortController();
	const reason = new Error("user aborted");
	const runner = async () => {
		ac.abort(reason);
		return { ok: false as const };
	};
	await assert.rejects(
		executeGhRouting({}, new URL("https://github.com/o/r/issues/1"), ac.signal, runner),
		/user aborted/,
	);
});

test("planGhRouting: job URLs inherit bypass semantics", () => {
	const u = new URL("https://github.com/o/r/actions/runs/1/job/7");
	assert.equal(planGhRouting({ raw: true }, u), null);
	assert.equal(planGhRouting({ method: "POST" }, u), null);
	assert.equal(planGhRouting({ body: "x" }, u), null);
	assert.equal(planGhRouting({ headers: { "x-foo": "1" } }, u), null);
	assert.equal(planGhRouting({}, u)!.kind, "job");
});
