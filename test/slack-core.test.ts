import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeApiCall,
	REQUEST_TIMEOUT_MS,
	MAX_RETRY_AFTER_MS,
	ERROR_HINTS,
	SlackError,
	resolveToken,
	DEFAULT_SLACK_CONFIG,
	defaultUploadBytes,
	type ApiCall,
	parsePermalink,
	searchMessages,
	readThread,
	gateOutput,
	INLINE_MAX_BYTES,
	INLINE_MAX_LINES,
	PREVIEW_MAX_LINES,
	PREVIEW_MAX_BYTES,
	THREAD_PAGE_CAP,
	THREAD_MESSAGE_CAP,
	postPlain,
	updateMessage,
	deleteMessage,
	pinMessage,
	uploadFile,
	MAX_TEXT_LENGTH,
	announce,
	postMessage,
	linkCollapsedLength,
	persistDetail,
	DETAIL_PENDING_MARKER,
	DETAIL_INTRO,
	DETAIL_FILENAME,
	buildPolicyBlock,
	formatUnresolvedSuffix,
	type UploadBytes,
} from "../lib/slack-core.ts";

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

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

test("REQUEST_TIMEOUT_MS and MAX_RETRY_AFTER_MS are the documented constants", () => {
	assert.equal(REQUEST_TIMEOUT_MS, 20_000);
	assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("apiCall: ok:true round-trip, bearer header, form encoding, JSON content-type", async () => {
	const seen: { path: string; auth: string | undefined; contentType: string | undefined; body: string }[] = [];
	const srv = await serve(async (req, res) => {
		seen.push({
			path: req.url ?? "",
			auth: req.headers["authorization"],
			contentType: req.headers["content-type"],
			body: await readBody(req),
		});
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		await apiCall("auth.test", "xoxb-test", {});
		await apiCall("chat.postMessage", "xoxb-test", { channel: "C1", blocks: [{ type: "section" }] });

		assert.equal(seen[0].path, "/api/auth.test");
		assert.equal(seen[0].auth, "Bearer xoxb-test");
		assert.match(seen[0].contentType ?? "", /application\/x-www-form-urlencoded/);

		assert.equal(seen[1].path, "/api/chat.postMessage");
		assert.equal(seen[1].auth, "Bearer xoxb-test");
		assert.match(seen[1].contentType ?? "", /application\/json/);
		const parsed = JSON.parse(seen[1].body);
		assert.equal(parsed.channel, "C1");
		assert.deepEqual(parsed.blocks, [{ type: "section" }]);
	} finally {
		srv.close();
	}
});

test("apiCall: ok:false channel_not_found maps to SlackError with hint, no raw dump", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "channel_not_found" }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		await assert.rejects(
			apiCall("conversations.info", "xoxb-test", { channel: "C1" }),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "channel_not_found");
				assert.match(err.message, /check the name or run slack_cache_refresh/);
				assert.doesNotMatch(err.message, /\{"ok"/);
				return true;
			},
		);
	} finally {
		srv.close();
	}
});

test("apiCall: hint table coverage", async () => {
	const cases: [string, RegExp][] = [
		["not_in_channel", /invite the bot to the channel/],
		["msg_too_long", /message exceeds Slack's length ceiling/],
		["is_archived", /the channel is archived/],
		["edit_window_closed", /Slack's edit window for this message has closed/],
		["already_pinned", /the message is already pinned/],
		["not_pinnable", /this message type cannot be pinned/],
	];
	for (const [code, hintRe] of cases) {
		const srv = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: code }));
		});
		try {
			const apiCall = makeApiCall(srv.url);
			await assert.rejects(
				apiCall("chat.postMessage", "xoxb-test", {}),
				(err: unknown) => {
					assert.ok(err instanceof SlackError);
					assert.equal(err.code, code);
					assert.match(err.message, hintRe);
					return true;
				},
			);
		} finally {
			srv.close();
		}
	}
});

test("apiCall: missing_scope names the needed scope and notes the token used was the one passed", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "missing_scope", needed: "chat:write" }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		await assert.rejects(
			apiCall("chat.postMessage", "xoxb-test", {}),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_scope");
				assert.match(err.message, /chat:write/);
				assert.match(err.message, /token/i);
				return true;
			},
		);
	} finally {
		srv.close();
	}
});

test("apiCall: unknown error code passes through with message = code, no hint", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "some_unmapped_code" }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		await assert.rejects(
			apiCall("chat.postMessage", "xoxb-test", {}),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "some_unmapped_code");
				assert.equal(err.message, "some_unmapped_code");
				return true;
			},
		);
	} finally {
		srv.close();
	}
});

test("apiCall: 429 with retry:true sleeps Retry-After then retries once and succeeds", async () => {
	let count = 0;
	const srv = await serve((_req, res) => {
		count += 1;
		if (count === 1) {
			res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
			res.end(JSON.stringify({ ok: false, error: "rate_limited" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		const result = await apiCall("chat.postMessage", "xoxb-test", {}, { retry: true });
		assert.deepEqual(result, { ok: true });
		assert.equal(count, 2);
	} finally {
		srv.close();
	}
});

test("apiCall: second consecutive 429 with retry:true throws rate_limited stating the wait", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
		res.end(JSON.stringify({ ok: false, error: "rate_limited" }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		await assert.rejects(
			apiCall("chat.postMessage", "xoxb-test", {}, { retry: true }),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "rate_limited");
				assert.match(err.message, /retry after/i);
				return true;
			},
		);
	} finally {
		srv.close();
	}
});

test("apiCall: 429 with retry:false throws immediately, exactly 1 request received", async () => {
	let count = 0;
	const srv = await serve((_req, res) => {
		count += 1;
		res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
		res.end(JSON.stringify({ ok: false, error: "rate_limited" }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		await assert.rejects(
			apiCall("chat.postMessage", "xoxb-test", {}, { retry: false }),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "rate_limited");
				return true;
			},
		);
		assert.equal(count, 1);
	} finally {
		srv.close();
	}
});

test("apiCall: Retry-After is capped at MAX_RETRY_AFTER_MS", async () => {
	let count = 0;
	const srv = await serve((_req, res) => {
		count += 1;
		if (count === 1) {
			res.writeHead(429, { "content-type": "application/json", "retry-after": "9999" });
			res.end(JSON.stringify({ ok: false, error: "rate_limited" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	try {
		let observedMs: number | undefined;
		const fakeSleep = async (ms: number, _signal?: AbortSignal) => {
			observedMs = ms;
		};
		const apiCall = makeApiCall(srv.url, fakeSleep);
		const result = await apiCall("chat.postMessage", "xoxb-test", {}, { retry: true });
		assert.deepEqual(result, { ok: true });
		assert.equal(observedMs, MAX_RETRY_AFTER_MS);
	} finally {
		srv.close();
	}
});

test("apiCall: 429 without Retry-After header defaults to 2000ms sleep", async () => {
	let count = 0;
	const srv = await serve((_req, res) => {
		count += 1;
		if (count === 1) {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "rate_limited" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	try {
		let observedMs: number | undefined;
		const fakeSleep = async (ms: number, _signal?: AbortSignal) => {
			observedMs = ms;
		};
		const apiCall = makeApiCall(srv.url, fakeSleep);
		const result = await apiCall("chat.postMessage", "xoxb-test", {}, { retry: true });
		assert.deepEqual(result, { ok: true });
		assert.equal(observedMs, 2000);
	} finally {
		srv.close();
	}
});

test("apiCall: pre-aborted signal rejects without making a request", async () => {
	let count = 0;
	const srv = await serve((_req, res) => {
		count += 1;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	try {
		const apiCall = makeApiCall(srv.url);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(apiCall("chat.postMessage", "xoxb-test", {}, { signal: controller.signal }), (err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "aborted");
			return true;
		});
		assert.equal(count, 0);
	} finally {
		srv.close();
	}
});

test("apiCall: mid-flight abort rejects with SlackError code aborted, not transport", async () => {
	const srv = await serve(() => {
		// never respond, forcing the abort to race the in-flight request
	});
	try {
		const apiCall = makeApiCall(srv.url);
		const controller = new AbortController();
		const pending = apiCall("chat.postMessage", "xoxb-test", {}, { signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(pending, (err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "aborted");
			return true;
		});
	} finally {
		srv.close();
	}
});

test("uploadBytes: raw POST, exact bytes, no authorization header, resolves on 200", async () => {
	const seen: { auth: string | undefined; body: Buffer }[] = [];
	const srv = await serve(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		seen.push({ auth: req.headers["authorization"], body: Buffer.concat(chunks) });
		res.writeHead(200);
		res.end();
	});
	try {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		await defaultUploadBytes(srv.url, bytes);
		assert.equal(seen[0].auth, undefined);
		assert.deepEqual(new Uint8Array(seen[0].body), bytes);
	} finally {
		srv.close();
	}
});

test("uploadBytes: non-2xx response throws SlackError with http_<status> code", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(500);
		res.end("boom");
	});
	try {
		await assert.rejects(
			defaultUploadBytes(srv.url, new Uint8Array([1])),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "http_500");
				return true;
			},
		);
	} finally {
		srv.close();
	}
});

test("apiCall: transport-level fetch failure maps to SlackError code 'transport'", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200);
		res.end();
	});
	const deadUrl = srv.url;
	srv.close();
	const apiCall = makeApiCall(deadUrl);
	await assert.rejects(
		apiCall("chat.postMessage", "xoxb-test", {}),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "transport");
			return true;
		},
	);
});

test("apiCall: near-zero timeout against a hung server yields SlackError code 'transport' with a timed-out message", async () => {
	const srv = await serve((_req, _res) => {
		// deliberately never respond
	});
	try {
		const apiCall = makeApiCall(srv.url, undefined, 5);
		await assert.rejects(
			apiCall("chat.postMessage", "xoxb-test", {}),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "transport");
				assert.match(err.message, /timed out after 5ms/);
				return true;
			},
		);
	} finally {
		srv.close();
	}
});

test("uploadBytes: transport-level fetch failure maps to SlackError code 'transport'", async () => {
	const srv = await serve((_req, res) => {
		res.writeHead(200);
		res.end();
	});
	const deadUrl = srv.url;
	srv.close();
	await assert.rejects(
		defaultUploadBytes(deadUrl, new Uint8Array([1])),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "transport");
			return true;
		},
	);
});

test("identity errors surface through core ops: missing bot token names the env var, no cross-identity fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-transport-token-"));
	try {
		assert.throws(
			() => resolveToken("bot", DEFAULT_SLACK_CONFIG, { SLACK_USER_TOKEN: "xoxp-present" }, dir),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				assert.match(err.message, /SLACK_BOT_TOKEN/);
				return true;
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parsePermalink: extracts channel and dotted ts", () => {
	const parsed = parsePermalink("https://x.slack.com/archives/C123/p1724900000123456");
	assert.deepEqual(parsed, { channel: "C123", ts: "1724900000.123456" });
});

test("parsePermalink: returns undefined for a non-matching url", () => {
	assert.equal(parsePermalink("https://example.com/foo"), undefined);
});

test("gateOutput: text under the inline caps is returned inline, not spilled", () => {
	const result = gateOutput("a short line", "unit");
	assert.equal(result.spilled, false);
	assert.equal(result.output, "a short line");
	assert.equal(result.path, undefined);
});

test("gateOutput: text over INLINE_MAX_BYTES spills to tmpdir/pi-slack with a bounded preview", () => {
	const big = "y".repeat(INLINE_MAX_BYTES + 1);
	const result = gateOutput(big, "unit");
	assert.equal(result.spilled, true);
	assert.ok(result.path);
	assert.ok(result.path!.startsWith(join(tmpdir(), "pi-slack")));
	assert.ok(Buffer.byteLength(result.output, "utf8") <= PREVIEW_MAX_BYTES + 200);
	assert.ok(result.output.split("\n").length <= PREVIEW_MAX_LINES + 5);
	const full = readFileSync(result.path!, "utf8");
	assert.equal(full, big);
});

test("gateOutput: text over INLINE_MAX_LINES spills even when under the byte cap", () => {
	const big = Array.from({ length: INLINE_MAX_LINES + 1 }, (_, i) => `line${i}`).join("\n");
	const result = gateOutput(big, "unit");
	assert.equal(result.spilled, true);
	assert.ok(result.path);
});

test("searchMessages: passes query verbatim (name-based operators untouched), clamps count to 100, forwards page, extracts paging, renders compact lines", async () => {
	let received: { method: string; token: string; params: Record<string, unknown>; opts?: { retry?: boolean } } | undefined;
	const apiCall: ApiCall = async (method, token, params, opts) => {
		received = { method, token, params, opts };
		return {
			ok: true,
			messages: {
				matches: [
					{
						username: "alice",
						channel: { name: "general" },
						ts: "1724900000.123456",
						permalink: "https://x.slack.com/archives/C1/p1",
						text: "hello world",
					},
				],
				paging: { count: 1, total: 42, page: 3, pages: 5 },
			},
		};
	};
	const result = await searchMessages(
		{ query: "in:#chan from:@person hello", count: 500, page: 3 },
		{ apiCall, token: "xoxp-test" },
	);
	assert.ok(received);
	assert.equal(received!.method, "search.messages");
	assert.equal(received!.token, "xoxp-test");
	assert.equal(received!.params.query, "in:#chan from:@person hello");
	assert.equal(received!.params.count, 100);
	assert.equal(received!.params.page, 3);
	assert.equal(received!.opts?.retry, false);
	assert.equal(result.total, 42);
	assert.equal(result.page, 3);
	assert.equal(result.pageCount, 5);
	assert.equal(result.output, "alice | #general | 1724900000.123456 | https://x.slack.com/archives/C1/p1 | hello world");
});

test("searchMessages: small result stays inline", async () => {
	const apiCall: ApiCall = async () => ({
		ok: true,
		messages: {
			matches: [{ username: "a", channel: { name: "c" }, ts: "1.1", permalink: "p", text: "hi" }],
			paging: { count: 1, total: 1, page: 1, pages: 1 },
		},
	});
	const result = await searchMessages({ query: "hi" }, { apiCall, token: "t" });
	assert.equal(result.spilled, false);
	assert.equal(result.path, undefined);
});

test("searchMessages: huge scripted result spills to tmpdir/pi-slack, bounded preview, full content on disk", async () => {
	const bigText = "x".repeat(50_000);
	const apiCall: ApiCall = async () => ({
		ok: true,
		messages: {
			matches: [{ username: "a", channel: { name: "c" }, ts: "1.1", permalink: "p", text: bigText }],
			paging: { count: 1, total: 1, page: 1, pages: 1 },
		},
	});
	const result = await searchMessages({ query: "hi" }, { apiCall, token: "t" });
	assert.equal(result.spilled, true);
	assert.ok(result.path);
	assert.ok(result.path!.startsWith(join(tmpdir(), "pi-slack")));
	assert.ok(result.output.split("\n").length <= PREVIEW_MAX_LINES + 5);
	assert.ok(Buffer.byteLength(result.output, "utf8") <= PREVIEW_MAX_BYTES + 200);
	const full = readFileSync(result.path!, "utf8");
	assert.ok(full.includes(bigText));
});

test("readThread: parses permalink and paginates 2 cursor pages to completion", async () => {
	const calls: { params: Record<string, unknown>; opts?: { retry?: boolean } }[] = [];
	const apiCall: ApiCall = async (_method, _token, params, opts) => {
		calls.push({ params, opts });
		if (!params.cursor) {
			return { ok: true, messages: [{ ts: "1" }, { ts: "2" }], has_more: true, response_metadata: { next_cursor: "CURSOR1" } };
		}
		return { ok: true, messages: [{ ts: "3" }], has_more: false, response_metadata: { next_cursor: "" } };
	};
	const result = await readThread(
		{ permalink: "https://x.slack.com/archives/C123/p1724900000123456" },
		{ apiCall, token: "t" },
	);
	assert.equal(calls[0].params.channel, "C123");
	assert.equal(calls[0].params.ts, "1724900000.123456");
	assert.equal(calls.length, 2);
	assert.ok(calls.every((c) => c.opts?.retry === false));
	assert.equal(result.complete, true);
	assert.equal(result.messageCount, 3);
	assert.equal(result.nextCursor, undefined);
});

test("readThread: forwards a provided starting cursor into the first conversations.replies call", async () => {
	const calls: { params: Record<string, unknown> }[] = [];
	const apiCall: ApiCall = async (_method, _token, params) => {
		calls.push({ params });
		return { ok: true, messages: [{ ts: "1" }], has_more: false, response_metadata: { next_cursor: "" } };
	};
	await readThread({ channel: "C1", ts: "1.1", cursor: "RESUME1" }, { apiCall, token: "t" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].params.cursor, "RESUME1");
});

test("readThread: caps at THREAD_PAGE_CAP pages when has_more never turns false, complete false with resumable cursor", async () => {
	let callCount = 0;
	const apiCall: ApiCall = async () => {
		callCount += 1;
		return { ok: true, messages: [{ ts: String(callCount) }], has_more: true, response_metadata: { next_cursor: `C${callCount}` } };
	};
	const result = await readThread({ channel: "C1", ts: "1.1" }, { apiCall, token: "t" });
	assert.equal(callCount, THREAD_PAGE_CAP);
	assert.equal(result.complete, false);
	assert.equal(result.messageCount, THREAD_PAGE_CAP);
	assert.ok(result.messageCount <= THREAD_MESSAGE_CAP);
	assert.equal(result.nextCursor, `C${THREAD_PAGE_CAP}`);
});

test("readThread: caps at THREAD_MESSAGE_CAP messages well before THREAD_PAGE_CAP when has_more never turns false", async () => {
	let callCount = 0;
	const apiCall: ApiCall = async () => {
		callCount += 1;
		const messages = Array.from({ length: 200 }, (_, i) => ({ ts: `${callCount}.${i}` }));
		return { ok: true, messages, has_more: true, response_metadata: { next_cursor: `C${callCount}` } };
	};
	const result = await readThread({ channel: "C1", ts: "1.1" }, { apiCall, token: "t" });
	assert.equal(callCount, 25);
	assert.ok(callCount < THREAD_PAGE_CAP);
	assert.equal(result.messageCount, THREAD_MESSAGE_CAP);
	assert.equal(result.messageCount, 5000);
	assert.equal(result.complete, false);
	assert.equal(result.nextCursor, `C${callCount}`);
});

test("readThread: a page that overshoots THREAD_MESSAGE_CAP is sliced to exactly 5,000, resuming from the current page's start cursor", async () => {
	let callCount = 0;
	const apiCall: ApiCall = async (_method, _token, params) => {
		callCount += 1;
		// 3,000 messages/page: page 1 -> 3,000 (under cap), page 2 -> 6,000 total (overshoots by 1,000).
		const messages = Array.from({ length: 3000 }, (_, i) => ({ ts: `${callCount}.${i}` }));
		return {
			ok: true,
			messages,
			has_more: true,
			response_metadata: { next_cursor: `C${callCount}` },
			// Echo the cursor this call was made with, so the test can assert nextCursor resumes
			// from the overshooting page's own start cursor, not the following page's cursor.
			_requestCursor: params.cursor,
		};
	};
	const result = await readThread({ channel: "C1", ts: "1.1" }, { apiCall, token: "t" });
	assert.equal(callCount, 2);
	assert.equal(result.messageCount, THREAD_MESSAGE_CAP);
	assert.equal(result.messageCount, 5000);
	assert.equal(result.complete, false);
	// Page 2 was fetched with cursor "C1" (page 1's next_cursor); since page 2 overshot, resuming
	// must re-fetch page 2 from its own start cursor "C1", not page 2's own next_cursor "C2".
	assert.equal(result.nextCursor, "C1");
});

test("gateOutput: byte-capped preview never ends mid multi-byte UTF-8 char (no U+FFFD)", () => {
	// Each euro sign is 3 UTF-8 bytes; sized so PREVIEW_MAX_BYTES lands mid-character.
	const text = "\u20ac".repeat(Math.ceil((INLINE_MAX_BYTES + PREVIEW_MAX_BYTES) / 3) + 10);
	const result = gateOutput(text, "unit");
	assert.equal(result.spilled, true);
	assert.ok(!result.output.includes("\uFFFD"));
});

test("readThread: 429 mid-pagination returns partial messages, complete false, throttle caveat, resumable next_cursor", async () => {
	let callCount = 0;
	const apiCall: ApiCall = async (_method, _token, _params, opts) => {
		callCount += 1;
		assert.equal(opts?.retry, false);
		if (callCount === 1) {
			return { ok: true, messages: [{ ts: "1" }], has_more: true, response_metadata: { next_cursor: "CUR1" } };
		}
		throw new SlackError("rate_limited", "Slack rate-limited conversations.replies; retry after 60s.");
	};
	const result = await readThread({ channel: "C1", ts: "1.1" }, { apiCall, token: "t" });
	assert.equal(result.messageCount, 1);
	assert.equal(result.complete, false);
	assert.equal(result.nextCursor, "CUR1");
	assert.match(result.caveat ?? "", /1 request\/minute/);
});

function recordingApiCall(
	script: (method: string, params: Record<string, unknown>) => Record<string, unknown> | Error,
): { apiCall: ApiCall; calls: { method: string; params: Record<string, unknown>; opts?: { retry?: boolean } }[] } {
	const calls: { method: string; params: Record<string, unknown>; opts?: { retry?: boolean } }[] = [];
	const apiCall: ApiCall = async (method, _token, params, opts) => {
		calls.push({ method, params, opts });
		const result = script(method, params);
		if (result instanceof Error) throw result;
		return result;
	};
	return { apiCall, calls };
}

test("postPlain: posts text, echoes channel/ts/permalink; mutating call retry:true, getPermalink retry:false", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "1.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p1000000" };
		throw new Error(`unexpected method ${method}`);
	});
	const result = await postPlain({ channel: "C1", text: "hello" }, { apiCall, token: "t" });
	assert.equal(result.channel, "C1");
	assert.equal(result.ts, "1.1");
	assert.equal(result.permalink, "https://x.slack.com/archives/C1/p1000000");
	assert.equal(result.warning, undefined);
	assert.deepEqual(
		calls.map((c) => c.method),
		["chat.postMessage", "chat.getPermalink"],
	);
	assert.equal(calls[0].opts?.retry, true);
	assert.equal(calls[1].opts?.retry, false);
});

test("postPlain: blocks forwarded verbatim, text optional", async () => {
	const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "2.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p2000000" };
		throw new Error(`unexpected method ${method}`);
	});
	await postPlain({ channel: "C1", blocks }, { apiCall, token: "t" });
	const postCall = calls.find((c) => c.method === "chat.postMessage");
	assert.deepEqual(postCall?.params.blocks, blocks);
	assert.equal(postCall?.params.text, undefined);
});

test("postPlain: text over MAX_TEXT_LENGTH throws before any transport call", async () => {
	const { apiCall, calls } = recordingApiCall(() => {
		throw new Error("should not be called");
	});
	const text = "a".repeat(MAX_TEXT_LENGTH + 1);
	await assert.rejects(
		postPlain({ channel: "C1", text }, { apiCall, token: "t" }),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.match(err.message, /thread_body|slack_upload/);
			return true;
		},
	);
	assert.equal(calls.length, 0);
});

test("postPlain: getPermalink failure degrades to a warning, post still succeeds", async () => {
	const { apiCall } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "3.3" };
		if (method === "chat.getPermalink") return new SlackError("some_error", "boom");
		throw new Error(`unexpected method ${method}`);
	});
	const result = await postPlain({ channel: "C1", text: "hi" }, { apiCall, token: "t" });
	assert.equal(result.channel, "C1");
	assert.equal(result.ts, "3.3");
	assert.equal(result.permalink, undefined);
	assert.match(result.warning ?? "", /permalink/i);
});

test("postPlain: chat.postMessage ok:true but no ts throws SlackError unexpected_response", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1" };
		throw new Error(`unexpected method ${method}`);
	});
	await assert.rejects(
		postPlain({ channel: "C1", text: "hi" }, { apiCall, token: "t" }),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "unexpected_response");
			assert.match(err.message, /chat\.postMessage/);
			assert.match(err.message, /ts/);
			return true;
		},
	);
	assert.deepEqual(
		calls.map((c) => c.method),
		["chat.postMessage"],
	);
});

test("updateMessage: chat.update round-trip with text/blocks, echoes permalink", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.update") return { ok: true, channel: "C1", ts: "4.4" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p4000000" };
		throw new Error(`unexpected method ${method}`);
	});
	const result = await updateMessage({ channel: "C1", ts: "4.4", text: "updated" }, { apiCall, token: "t" });
	assert.equal(result.channel, "C1");
	assert.equal(result.ts, "4.4");
	assert.equal(result.permalink, "https://x.slack.com/archives/C1/p4000000");
	const updateCall = calls.find((c) => c.method === "chat.update");
	assert.equal(updateCall?.params.channel, "C1");
	assert.equal(updateCall?.params.ts, "4.4");
	assert.equal(updateCall?.params.text, "updated");
	assert.equal(updateCall?.opts?.retry, true);
});

test("deleteMessage: chat.delete round-trip, no getPermalink call", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.delete") return { ok: true };
		throw new Error(`unexpected method ${method}`);
	});
	const result = await deleteMessage({ channel: "C1", ts: "5.5" }, { apiCall, token: "t" });
	assert.deepEqual(result, { channel: "C1", ts: "5.5" });
	assert.deepEqual(
		calls.map((c) => c.method),
		["chat.delete"],
	);
	assert.equal(calls[0].opts?.retry, true);
	assert.equal(calls[0].params.channel, "C1");
	assert.equal(calls[0].params.ts, "5.5");
});

test("pinMessage: pins.add round-trip, echoes permalink", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "pins.add") return { ok: true };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p6000000" };
		throw new Error(`unexpected method ${method}`);
	});
	const result = await pinMessage({ channel: "C1", ts: "6.6" }, { apiCall, token: "t" });
	assert.equal(result.channel, "C1");
	assert.equal(result.ts, "6.6");
	assert.equal(result.permalink, "https://x.slack.com/archives/C1/p6000000");
	const pinCall = calls.find((c) => c.method === "pins.add");
	assert.equal(pinCall?.params.channel, "C1");
	assert.equal(pinCall?.params.timestamp, "6.6");
	assert.equal(pinCall?.opts?.retry, true);
});

test("pinMessage: chat.getPermalink failure degrades to a warning, pin still succeeds", async () => {
	const { apiCall } = recordingApiCall((method) => {
		if (method === "pins.add") return { ok: true };
		if (method === "chat.getPermalink") return new SlackError("some_error", "boom");
		throw new Error(`unexpected method ${method}`);
	});
	const result = await pinMessage({ channel: "C1", ts: "6.6" }, { apiCall, token: "t" });
	assert.equal(result.channel, "C1");
	assert.equal(result.ts, "6.6");
	assert.equal(result.permalink, undefined);
	assert.match(result.warning ?? "", /permalink/i);
});

test("uploadFile: getUploadURLExternal -> uploadBytes -> completeUploadExternal, echoes fileId", async () => {
	const bytes = new Uint8Array([9, 8, 7]);
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://upload.example/x", file_id: "F123" };
		if (method === "files.completeUploadExternal") return { ok: true, files: [{ id: "F123" }] };
		throw new Error(`unexpected method ${method}`);
	});
	const uploadCalls: { url: string; bytes: Uint8Array }[] = [];
	const uploadBytes: UploadBytes = async (url, b) => {
		uploadCalls.push({ url, bytes: b });
	};
	const result = await uploadFile(
		{ channel: "C1", bytes, filename: "report.pdf", title: "Report", thread_ts: "1.1", initial_comment: "here" },
		{ apiCall, token: "t", uploadBytes },
	);

	assert.deepEqual(
		calls.map((c) => c.method),
		["files.getUploadURLExternal", "files.completeUploadExternal"],
	);
	assert.equal(calls[0].params.filename, "report.pdf");
	assert.equal(calls[0].params.length, bytes.length);

	assert.equal(uploadCalls.length, 1);
	assert.equal(uploadCalls[0].url, "https://upload.example/x");
	assert.deepEqual(uploadCalls[0].bytes, bytes);

	const completeCall = calls[1];
	assert.equal(completeCall.params.channel_id, "C1");
	assert.equal(completeCall.params.thread_ts, "1.1");
	assert.equal(completeCall.params.initial_comment, "here");
	const filesJson = JSON.parse(completeCall.params.files as string);
	assert.deepEqual(filesJson, [{ id: "F123", title: "Report" }]);

	assert.equal(result.fileId, "F123");
	assert.equal(result.channel, "C1");
	assert.equal(result.ts, undefined);
	assert.equal(result.permalink, undefined);
	assert.match(result.warning ?? "", /permalink/i);

	const getUrlCall = calls.find((c) => c.method === "files.getUploadURLExternal");
	assert.equal(getUrlCall?.opts?.retry, true);
	assert.equal(completeCall.opts?.retry, false);
});

test("uploadFile: echoes permalink from the completed file object when present, no warning", async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const { apiCall } = recordingApiCall((method) => {
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://upload.example/x", file_id: "F999" };
		if (method === "files.completeUploadExternal")
			return { ok: true, files: [{ id: "F999", permalink: "https://x.slack.com/files/U1/F999/report.pdf" }] };
		throw new Error(`unexpected method ${method}`);
	});
	const uploadBytes: UploadBytes = async () => {};
	const result = await uploadFile({ channel: "C1", bytes, filename: "report.pdf" }, { apiCall, token: "t", uploadBytes });
	assert.equal(result.fileId, "F999");
	assert.equal(result.permalink, "https://x.slack.com/files/U1/F999/report.pdf");
	assert.equal(result.warning, undefined);
});

test("uploadFile: uploadBytes rejection propagates and files.completeUploadExternal is never invoked", async () => {
	const bytes = new Uint8Array([9, 8, 7]);
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://upload.example/x", file_id: "F123" };
		if (method === "files.completeUploadExternal") return { ok: true, files: [{ id: "F123" }] };
		throw new Error(`unexpected method ${method}`);
	});
	const uploadBytes: UploadBytes = async () => {
		throw new SlackError("transport", "upload failed");
	};
	await assert.rejects(
		uploadFile({ channel: "C1", bytes, filename: "report.pdf" }, { apiCall, token: "t", uploadBytes }),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "transport");
			return true;
		},
	);
	assert.deepEqual(
		calls.map((c) => c.method),
		["files.getUploadURLExternal"],
	);
});

function noopUploadBytes(): UploadBytes {
	return async () => {};
}

function announceDeps(apiCall: ApiCall, uploadBytes: UploadBytes = noopUploadBytes()) {
	return { apiCall, token: "t", uploadBytes, thresholdChars: 4000 };
}

test("announce: happy path posts headline (retry:false) then detail as threaded reply (retry:true)", async () => {
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "10.1" };
		if (method === "chat.postMessage" && params.thread_ts === "10.1") return { ok: true, channel: "C1", ts: "10.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p10000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});
	const result = await announce({ channel: "C1", text: "Headline", thread_body: "Detail body" }, announceDeps(apiCall));

	const postCalls = calls.filter((c) => c.method === "chat.postMessage");
	assert.equal(postCalls.length, 2);
	assert.equal(postCalls[0].params.thread_ts, undefined);
	assert.equal(postCalls[0].opts?.retry, false);
	assert.equal(postCalls[1].params.thread_ts, "10.1");
	assert.equal(postCalls[1].opts?.retry, true);

	assert.equal(result.channel, "C1");
	assert.equal(result.ts, "10.1");
	assert.equal(result.permalink, "https://x.slack.com/archives/C1/p10000001");
	assert.equal(result.detailTs, "10.2");
});

test("announce: pre-flight rejects empty / multi-line / oversized headline before any transport call", async () => {
	const { apiCall, calls } = recordingApiCall(() => {
		throw new Error("transport should never be reached");
	});

	await assert.rejects(announce({ channel: "C1", text: "", thread_body: "d" }, announceDeps(apiCall)));
	await assert.rejects(announce({ channel: "C1", text: "line one\nline two", thread_body: "d" }, announceDeps(apiCall)));
	await assert.rejects(
		announce({ channel: "C1", text: "x".repeat(MAX_TEXT_LENGTH + 1), thread_body: "d" }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "text_too_long");
			return true;
		},
	);
	assert.equal(calls.length, 0);
});

test("announce: detail post fails -> headline gets pending marker, detail persisted, structured error", async () => {
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "11.1" };
		if (method === "chat.postMessage" && params.thread_ts === "11.1") return new SlackError("internal_error", "internal_error");
		if (method === "chat.update") return { ok: true, channel: "C1", ts: "11.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p11000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: "Detail body verbatim" }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "detail_failed");
			assert.match(err.message, /internal_error/);
			assert.equal((err.data as Record<string, unknown>)?.ts, "11.1");
			assert.equal((err.data as Record<string, unknown>)?.channel, "C1");
			assert.equal((err.data as Record<string, unknown>)?.permalink, "https://x.slack.com/archives/C1/p11000001");
			const detailPath = (err.data as Record<string, unknown>)?.detailPath as string;
			assert.ok(detailPath && detailPath.includes("pi-slack"));
			assert.equal(readFileSync(detailPath, "utf8"), "Detail body verbatim");
			return true;
		},
	);

	const updateCall = calls.find((c) => c.method === "chat.update");
	assert.equal(updateCall?.params.channel, "C1");
	assert.equal(updateCall?.params.ts, "11.1");
	assert.equal(updateCall?.params.text, `Headline${DETAIL_PENDING_MARKER}`);

	const headlineShaped = calls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts === undefined);
	assert.equal(headlineShaped.length, 1);
});

test("announce: detail post fails AND the marker edit also fails -> error names both failures", async () => {
	const { apiCall } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "12.1" };
		if (method === "chat.postMessage" && params.thread_ts === "12.1") return new SlackError("internal_error", "internal_error");
		if (method === "chat.update") return new SlackError("edit_window_closed", "edit_window_closed: Slack's edit window for this message has closed");
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p12000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: "Detail body" }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "detail_failed");
			assert.match(err.message, /edit_window_closed/);
			assert.equal((err.data as Record<string, unknown>)?.ts, "12.1");
			assert.ok((err.data as Record<string, unknown>)?.detailPath);
			return true;
		},
	);
});

test("announce: headline transport failure -> outcome_unknown, detail persisted, exactly one request attempted", async () => {
	const { apiCall, calls } = recordingApiCall(() => {
		return new SlackError("transport", "Slack API request to chat.postMessage failed: timed out after 20000ms");
	});

	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: "Detail body" }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "outcome_unknown");
			assert.match(err.message, /check the channel/i);
			const detailPath = (err.data as Record<string, unknown>)?.detailPath as string;
			assert.ok(detailPath);
			assert.equal(readFileSync(detailPath, "utf8"), "Detail body");
			return true;
		},
	);
	assert.equal(calls.length, 1);
});

test("postMessage: recovery with thread_ts posts only into the existing thread, never a second headline", async () => {
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "13.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p13000002" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	const result = await postMessage(
		{ channel: "C1", thread_ts: "13.1", thread_body: "Follow-up detail" },
		announceDeps(apiCall),
	);

	const postCalls = calls.filter((c) => c.method === "chat.postMessage");
	assert.ok(postCalls.length >= 1);
	for (const c of postCalls) assert.equal(c.params.thread_ts, "13.1");
	assert.equal(postCalls[0].params.text, "Follow-up detail");
	assert.equal(result.ts, "13.2");
});

test("postMessage: announce then two sequential thread replies on the same transport -> exactly one headline across all calls", async () => {
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "20.1" };
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "20.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p20000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});
	const deps = announceDeps(apiCall);

	const announced = await postMessage({ channel: "C1", text: "Headline", thread_body: "Detail body" }, deps);
	await postMessage({ channel: "C1", thread_ts: announced.ts, thread_body: "Follow-up 1" }, deps);
	await postMessage({ channel: "C1", thread_ts: announced.ts, thread_body: "Follow-up 2" }, deps);

	const postCalls = calls.filter((c) => c.method === "chat.postMessage");
	const headlineShaped = postCalls.filter((c) => c.params.thread_ts === undefined);
	assert.equal(headlineShaped.length, 1);
});

test("announce: oversized detail (>threshold, non-link chars) delivers as threaded upload, no detail-sized chat.postMessage", async () => {
	const uploadCalls: { url: string; bytes: Uint8Array }[] = [];
	const uploadBytes: UploadBytes = async (url, bytes) => {
		uploadCalls.push({ url, bytes });
	};
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "14.1" };
		if (method === "chat.postMessage" && params.thread_ts === "14.1") return { ok: true, channel: "C1", ts: "14.2" };
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://upload.example/y", file_id: "F14" };
		if (method === "files.completeUploadExternal") return { ok: true, files: [{ id: "F14" }] };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p14000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	const bigBody = "x".repeat(4001);
	const result = await announce({ channel: "C1", text: "Headline", thread_body: bigBody }, announceDeps(apiCall, uploadBytes));

	const threadedPosts = calls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts === "14.1");
	assert.equal(threadedPosts.length, 1);
	assert.equal(threadedPosts[0].params.text, DETAIL_INTRO);

	assert.deepEqual(
		calls.filter((c) => c.method.startsWith("files.")).map((c) => c.method),
		["files.getUploadURLExternal", "files.completeUploadExternal"],
	);
	const filesJson = JSON.parse(
		(calls.find((c) => c.method === "files.completeUploadExternal")?.params.files as string) ?? "[]",
	);
	assert.equal(calls.find((c) => c.method === "files.getUploadURLExternal")?.params.filename, DETAIL_FILENAME);
	assert.equal(calls.find((c) => c.method === "files.completeUploadExternal")?.params.thread_ts, "14.1");
	assert.equal(uploadCalls.length, 1);
	assert.equal(result.ts, "14.1");
	assert.equal(result.detailTs, "14.2");
	assert.equal(result.detailUploaded, true);
});

test("linkCollapsedLength: labeled links collapse to their label; a link-heavy 5000-char body stays under threshold", async () => {
	assert.equal(linkCollapsedLength("<https://x|hi>"), 2);
	assert.equal(linkCollapsedLength("<https://example.com>"), 1);

	const link = "<https://example.com/path|hi>"; // label "hi" = 2 chars per link
	let body = "";
	while (body.length < 5000) body += link;
	assert.ok(body.length > 5000);
	assert.ok(linkCollapsedLength(body) < 4000);

	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "15.1" };
		if (method === "chat.postMessage" && params.thread_ts === "15.1") return { ok: true, channel: "C1", ts: "15.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p15000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});
	const result = await announce({ channel: "C1", text: "Headline", thread_body: body }, announceDeps(apiCall));
	assert.equal(result.detailTs, "15.2");
	assert.equal(
		calls.filter((c) => c.method.startsWith("files.")).length,
		0,
	);
	// Inline detail leg (no upload) must never claim the upload-only discriminant.
	assert.equal(result.detailUploaded, undefined);
});

test("announce: msg_too_long slips through the threshold gate -> falls back to upload, no marker edit, no error", async () => {
	const uploadBytes: UploadBytes = async () => {};
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "16.1" };
		if (method === "chat.postMessage" && params.thread_ts === "16.1" && params.text === DETAIL_INTRO) return { ok: true, channel: "C1", ts: "16.3" };
		if (method === "chat.postMessage" && params.thread_ts === "16.1") return new SlackError("msg_too_long", "msg_too_long: message exceeds Slack's length ceiling");
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://upload.example/z", file_id: "F16" };
		if (method === "files.completeUploadExternal") return { ok: true, files: [{ id: "F16" }] };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p16000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	const result = await announce({ channel: "C1", text: "Headline", thread_body: "short body" }, announceDeps(apiCall, uploadBytes));
	assert.equal(result.ts, "16.1");
	assert.equal(calls.some((c) => c.method === "chat.update"), false);
	assert.deepEqual(
		calls.filter((c) => c.method.startsWith("files.")).map((c) => c.method),
		["files.getUploadURLExternal", "files.completeUploadExternal"],
	);
	assert.equal(result.detailUploaded, true);
});

test("postMessage: thread_ts + caller-supplied blocks bypasses upload-fallback logic entirely, forwards blocks verbatim", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "18.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p18000002" };
		throw new Error(`unexpected method ${method}`);
	});
	const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
	const result = await postMessage(
		{ channel: "C1", thread_ts: "18.1", blocks, text: "fallback text" },
		announceDeps(apiCall),
	);
	const postCalls = calls.filter((c) => c.method === "chat.postMessage");
	assert.equal(postCalls.length, 1);
	assert.deepEqual(postCalls[0].params.blocks, blocks);
	assert.equal(postCalls[0].params.text, "fallback text");
	assert.equal(postCalls[0].params.thread_ts, "18.1");
	assert.equal(
		calls.filter((c) => c.method.startsWith("files.")).length,
		0,
	);
	assert.equal(result.ts, "18.2");
});

test("postMessage: thread_ts + blocks + thread_body prefers thread_body as the reply body over text, blocks forwarded verbatim", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "19.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p19000002" };
		throw new Error(`unexpected method ${method}`);
	});
	const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
	const result = await postMessage(
		{ channel: "C1", thread_ts: "19.1", blocks, thread_body: "intended reply", text: "fallback" },
		announceDeps(apiCall),
	);
	const postCalls = calls.filter((c) => c.method === "chat.postMessage");
	assert.equal(postCalls.length, 1);
	assert.equal(postCalls[0].params.text, "intended reply");
	assert.deepEqual(postCalls[0].params.blocks, blocks);
	assert.equal(postCalls[0].params.thread_ts, "19.1");
	assert.equal(result.ts, "19.2");
});

test("postMessage: dispatches thread_body+thread_ts -> reply (no headline), no thread info -> postPlain, blocks -> postPlain with blocks", async () => {
	const { apiCall: replyApiCall, calls: replyCalls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "17.2" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p17000002" };
		throw new Error(`unexpected method ${method}`);
	});
	await postMessage({ channel: "C1", thread_ts: "17.1", thread_body: "reply body" }, announceDeps(replyApiCall));
	assert.equal(replyCalls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts === undefined).length, 0);

	const { apiCall: plainApiCall, calls: plainCalls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "17.3" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p17000003" };
		throw new Error(`unexpected method ${method}`);
	});
	await postMessage({ channel: "C1", text: "just text" }, announceDeps(plainApiCall));
	assert.equal(plainCalls[0].params.text, "just text");
	assert.equal(plainCalls[0].params.thread_ts, undefined);

	const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
	const { apiCall: blocksApiCall, calls: blocksCalls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "17.4" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p17000004" };
		throw new Error(`unexpected method ${method}`);
	});
	await postMessage({ channel: "C1", blocks }, announceDeps(blocksApiCall));
	assert.deepEqual(blocksCalls[0].params.blocks, blocks);
});

test("persistDetail: writes body verbatim to a timestamped file under tmpdir()/pi-slack", () => {
	const path = persistDetail("verbatim contents");
	assert.ok(path.includes(join(tmpdir(), "pi-slack")));
	assert.equal(readFileSync(path, "utf8"), "verbatim contents");
});

test("announce: oversized-detail upload failure -> headline marked pending, detail persisted, structured detail_failed error", async () => {
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "30.1" };
		if (method === "chat.postMessage" && params.thread_ts === "30.1" && params.text === DETAIL_INTRO) return { ok: true, channel: "C1", ts: "30.2" };
		if (method === "files.getUploadURLExternal") return new SlackError("internal_error", "internal_error");
		if (method === "chat.update") return { ok: true, channel: "C1", ts: "30.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p30000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	const bigBody = "x".repeat(4001);
	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: bigBody }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "detail_failed");
			assert.match(err.message, /internal_error/);
			assert.equal((err.data as Record<string, unknown>)?.ts, "30.1");
			assert.equal((err.data as Record<string, unknown>)?.channel, "C1");
			const detailPath = (err.data as Record<string, unknown>)?.detailPath as string;
			assert.ok(detailPath && detailPath.includes("pi-slack"));
			assert.equal(readFileSync(detailPath, "utf8"), bigBody);
			return true;
		},
	);

	const updateCall = calls.find((c) => c.method === "chat.update");
	assert.equal(updateCall?.params.text, `Headline${DETAIL_PENDING_MARKER}`);
});

test("announce: msg_too_long fallback upload itself fails -> headline marked pending, detail persisted, structured detail_failed error", async () => {
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "31.1" };
		if (method === "chat.postMessage" && params.thread_ts === "31.1" && params.text === DETAIL_INTRO) return { ok: true, channel: "C1", ts: "31.2" };
		if (method === "chat.postMessage" && params.thread_ts === "31.1") return new SlackError("msg_too_long", "msg_too_long: message exceeds Slack's length ceiling");
		if (method === "files.getUploadURLExternal") return new SlackError("internal_error", "internal_error");
		if (method === "chat.update") return { ok: true, channel: "C1", ts: "31.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p31000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: "short body" }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "detail_failed");
			assert.match(err.message, /internal_error/);
			assert.equal((err.data as Record<string, unknown>)?.ts, "31.1");
			const detailPath = (err.data as Record<string, unknown>)?.detailPath as string;
			assert.ok(detailPath && detailPath.includes("pi-slack"));
			assert.equal(readFileSync(detailPath, "utf8"), "short body");
			return true;
		},
	);

	const updateCall = calls.find((c) => c.method === "chat.update");
	assert.equal(updateCall?.params.text, `Headline${DETAIL_PENDING_MARKER}`);
});

test("postMessage: thread_ts reply over threshold, upload fails -> detail_failed error carries channel/thread_ts/detailPath, body persisted verbatim", async () => {
	const { apiCall } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === "40.1" && params.text === DETAIL_INTRO) return { ok: true, channel: "C1", ts: "40.2" };
		if (method === "files.getUploadURLExternal") return new SlackError("internal_error", "internal_error");
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	const bigBody = "x".repeat(4001);
	await assert.rejects(
		postMessage({ channel: "C1", thread_ts: "40.1", thread_body: bigBody }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "detail_failed");
			assert.match(err.message, /internal_error/);
			assert.equal((err.data as Record<string, unknown>)?.channel, "C1");
			assert.equal((err.data as Record<string, unknown>)?.thread_ts, "40.1");
			const detailPath = (err.data as Record<string, unknown>)?.detailPath as string;
			assert.ok(detailPath && detailPath.includes("pi-slack"));
			assert.equal(readFileSync(detailPath, "utf8"), bigBody);
			return true;
		},
	);
});

test("announce: detail post fails AND persistDetail (injected) also fails -> message states persistence failed with the body length, detailPath omitted", async () => {
	const { apiCall } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1", ts: "32.1" };
		if (method === "chat.postMessage" && params.thread_ts === "32.1") return new SlackError("internal_error", "internal_error");
		if (method === "chat.update") return { ok: true, channel: "C1", ts: "32.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p32000001" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});
	const body = "Detail body for persist-failure test";
	const failingPersist = () => {
		throw new Error("disk full");
	};

	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: body }, { ...announceDeps(apiCall), persist: failingPersist }),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "detail_failed");
			assert.match(err.message, /also failed/i);
			assert.match(err.message, new RegExp(String(body.length)));
			assert.equal((err.data as Record<string, unknown>)?.detailPath, undefined);
			return true;
		},
	);
});

test("announce: headline accepted (ok:true) but ts unparseable -> outcome_unknown, does not invite re-invoke, detail persisted", async () => {
	const { apiCall } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage" && params.thread_ts === undefined) return { ok: true, channel: "C1" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	await assert.rejects(
		announce({ channel: "C1", text: "Headline", thread_body: "Detail body" }, announceDeps(apiCall)),
		(err: unknown) => {
			assert.ok(err instanceof SlackError);
			assert.equal(err.code, "outcome_unknown");
			assert.match(err.message, /do not re-invoke/i);
			assert.match(err.message, /accepted/i);
			const detailPath = (err.data as Record<string, unknown>)?.detailPath as string;
			assert.ok(detailPath);
			assert.equal(readFileSync(detailPath, "utf8"), "Detail body");
			return true;
		},
	);
});

test("postMessage: thread_ts reply with raw length over MAX_TEXT_LENGTH but collapsed length under threshold -> delivered via upload fallback, no throw", async () => {
	const uploadCalls: { url: string; bytes: Uint8Array }[] = [];
	const uploadBytes: UploadBytes = async (url, bytes) => {
		uploadCalls.push({ url, bytes });
	};
	const { apiCall, calls } = recordingApiCall((method, params) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "33.2" };
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://upload.example/w", file_id: "F33" };
		if (method === "files.completeUploadExternal") return { ok: true, files: [{ id: "F33" }] };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x.slack.com/archives/C1/p33000002" };
		throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
	});

	// Link-heavy: raw length exceeds MAX_TEXT_LENGTH but collapses under the 4000-char threshold.
	const link = "<https://example.com/some/very/long/path/segment|x>"; // label "x" collapses to 1 char
	let body = "";
	while (body.length <= MAX_TEXT_LENGTH) body += link;
	assert.ok(body.length > MAX_TEXT_LENGTH);
	assert.ok(linkCollapsedLength(body) < 4000);

	const result = await postMessage({ channel: "C1", thread_ts: "33.1", thread_body: body }, announceDeps(apiCall, uploadBytes));
	assert.equal(result.ts, "33.1");
	assert.equal(uploadCalls.length, 1);
	assert.deepEqual(
		calls.filter((c) => c.method.startsWith("files.")).map((c) => c.method),
		["files.getUploadURLExternal", "files.completeUploadExternal"],
	);
});

// --- gh-9: buildPolicyBlock ---

test("buildPolicyBlock: ok status wraps the body verbatim and names the configured source", () => {
	const block = buildPolicyBlock({ source: "doc/SLACK.md", status: "ok", body: "Always confirm exact text.\n" });
	assert.equal(block, '<slack-policy source="doc/SLACK.md">\nAlways confirm exact text.\n</slack-policy>');
});

test("buildPolicyBlock: unreadable status carries the errno and tells the model policy is unknown", () => {
	const block = buildPolicyBlock({ source: "doc/SLACK.md", status: "unreadable", code: "ENOENT" });
	assert.match(block, /^<slack-policy source="doc\/SLACK\.md" status="unreadable">\n/);
	assert.match(block, /could not be read \(ENOENT\)/);
	assert.match(block, /ask the operator before posting/);
	assert.match(block, /<\/slack-policy>$/);
});

test("buildPolicyBlock: empty status says the file is empty", () => {
	const block = buildPolicyBlock({ source: "doc/SLACK.md", status: "empty" });
	assert.match(block, /status="empty"/);
	assert.match(block, /is empty/);
});

test("buildPolicyBlock: escapes &, <, >, \" in the source attribute", () => {
	const block = buildPolicyBlock({ source: 'a&b<c>d"e.md', status: "ok", body: "x" });
	assert.match(block, /source="a&amp;b&lt;c&gt;d&quot;e\.md"/);
});

// --- gh-9: formatUnresolvedSuffix ---

test("formatUnresolvedSuffix: empty list yields no suffix", () => {
	assert.equal(formatUnresolvedSuffix([], {}), "");
});

test("formatUnresolvedSuffix: dedups by name in first-seen order", () => {
	const suffix = formatUnresolvedSuffix(
		[
			{ field: "text" as const, name: "@bob" },
			{ field: "thread_body" as const, name: "@alice" },
			{ field: "thread_body" as const, name: "@bob" },
		],
		{},
	);
	assert.equal(suffix, "unresolved mentions: @bob, @alice");
});

test("formatUnresolvedSuffix: lookupError appends the reason", () => {
	const suffix = formatUnresolvedSuffix([{ field: "text" as const, name: "@alice" }], { lookupError: "ratelimited" });
	assert.equal(suffix, "unresolved mentions: @alice (lookup failed: ratelimited)");
});

test("formatUnresolvedSuffix: uploaded detail with a thread_body miss adds the repair note", () => {
	const suffix = formatUnresolvedSuffix([{ field: "thread_body" as const, name: "@alice" }], { detailUploaded: true });
	assert.equal(
		suffix,
		"unresolved mentions: @alice (detail uploaded as a file - slack_update cannot repair it; repost to fix)",
	);
});

test("formatUnresolvedSuffix: uploaded detail with only a text miss adds no repair note", () => {
	const suffix = formatUnresolvedSuffix([{ field: "text" as const, name: "@alice" }], { detailUploaded: true });
	assert.equal(suffix, "unresolved mentions: @alice");
});

test("formatUnresolvedSuffix: lookupError and uploaded detail on a thread_body miss both appear", () => {
	const suffix = formatUnresolvedSuffix([{ field: "thread_body" as const, name: "@alice" }], {
		lookupError: "ratelimited",
		detailUploaded: true,
	});
	assert.equal(
		suffix,
		"unresolved mentions: @alice (lookup failed: ratelimited) (detail uploaded as a file - slack_update cannot repair it; repost to fix)",
	);
});

// --- gh-9: unfurl params ---

test("postPlain: unfurl params omitted from the payload when unset", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "1.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x/p1" };
		throw new Error(`unexpected method ${method}`);
	});
	await postPlain({ channel: "C1", text: "hi" }, { apiCall, token: "t" });
	const post = calls.find((c) => c.method === "chat.postMessage");
	assert.equal("unfurl_links" in (post?.params ?? {}), false);
	assert.equal("unfurl_media" in (post?.params ?? {}), false);
});

test("postPlain: explicit false survives (not dropped as falsy)", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "1.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x/p1" };
		throw new Error(`unexpected method ${method}`);
	});
	await postPlain({ channel: "C1", text: "hi", unfurl_links: false, unfurl_media: false }, { apiCall, token: "t" });
	const post = calls.find((c) => c.method === "chat.postMessage");
	assert.equal(post?.params.unfurl_links, false);
	assert.equal(post?.params.unfurl_media, false);
});

test("announce: unfurl params reach the headline and the inline detail post", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "1.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x/p1" };
		throw new Error(`unexpected method ${method}`);
	});
	await announce(
		{ channel: "C1", text: "headline", thread_body: "detail" },
		{ apiCall, token: "t", uploadBytes: (async () => {}) as UploadBytes, thresholdChars: 4000, unfurl_links: false },
	);
	const posts = calls.filter((c) => c.method === "chat.postMessage");
	assert.equal(posts.length, 2);
	assert.equal(posts[0].params.unfurl_links, false);
	assert.equal(posts[1].params.unfurl_links, false);
});

test("announce: unfurl params never reach the Detail attached. upload stub", async () => {
	const { apiCall, calls } = recordingApiCall((method) => {
		if (method === "chat.postMessage") return { ok: true, channel: "C1", ts: "1.1" };
		if (method === "chat.getPermalink") return { ok: true, permalink: "https://x/p1" };
		if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://u", file_id: "F1" };
		if (method === "files.completeUploadExternal") return { ok: true, files: [{ permalink: "https://x/f1" }] };
		throw new Error(`unexpected method ${method}`);
	});
	await announce(
		{ channel: "C1", text: "headline", thread_body: "d".repeat(50) },
		{ apiCall, token: "t", uploadBytes: (async () => {}) as UploadBytes, thresholdChars: 10, unfurl_links: false },
	);
	const stub = calls.filter((c) => c.method === "chat.postMessage").find((c) => c.params.text === DETAIL_INTRO);
	assert.ok(stub, "expected the Detail attached. stub post");
	assert.equal("unfurl_links" in stub.params, false);
});
