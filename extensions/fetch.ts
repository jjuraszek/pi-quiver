/**
 * Fetch Extension
 *
 * Registers a `fetch` tool that retrieves URLs with context-safe output routing.
 * HTML is extracted to structured Markdown via readability + turndown (boilerplate
 * stripped, headings/lists/tables/code fences preserved). Binary content (images,
 * PDFs, archives, etc.) is saved untouched to a temp file and only the path is
 * returned. Text/Markdown/JSON over 32 KB or 1000 lines is written to a temp file
 * with a 60-line preview; smaller content is returned inline. Parsable downloads
 * are capped at 1 MB; binary downloads at 50 MB.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { fetchUrl, DEFAULT_TIMEOUT_MS, type FetchToolDetails } from "../lib/fetch-core.ts";

export default function fetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch",
		label: "Fetch URL",
		description:
			"Fetch a URL over HTTP(S). HTML is extracted to Markdown (readability + turndown). Binary content (images, PDFs, archives) is saved untouched to a temp file and only a path is returned. Text/Markdown/JSON over 32KB or 1000 lines is written to a temp file with a 60-line preview; smaller content is returned inline. Parsable downloads are capped at 1MB, binary at 50MB. When the body is written to a file, grep it or read with offset/limit; converted Markdown is grep-able by heading (^#). GitHub issue/PR/repo/actions-run URLs are served via the gh CLI when available (falls back to HTTP otherwise; raw=true forces the rendered HTML page).",
		promptSnippet: "Fetch the contents of a URL",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL" }),
			method: Type.Optional(
				Type.Union(
					[Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST")],
					{ default: "GET" },
				),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Extra request headers (override defaults like UA)",
				}),
			),
			body: Type.Optional(Type.String({ description: "Request body for POST" })),
			raw: Type.Optional(
				Type.Boolean({ description: "Skip HTML→Markdown and JSON pretty-printing; return the decoded body as-is" }),
			),
			timeoutMs: Type.Optional(Type.Number({ default: DEFAULT_TIMEOUT_MS })),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await fetchUrl({ ...params, signal: signal ?? undefined });
			return {
				content: [{ type: "text" as const, text: result.output }],
				details: result.details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("fetch "));
			const method = args.method ?? "GET";
			if (method !== "GET") {
				text += theme.fg("warning", `${method} `);
			}
			text += theme.fg("accent", args.url ?? "");
			if (args.raw) {
				text += theme.fg("dim", " (raw)");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const details = result.details as FetchToolDetails | undefined;
			const content = result.content[0];
			const fullText = content?.type === "text" ? content.text : "";

			if (context.isError) {
				const firstLine = fullText.split("\n")[0] || "fetch failed";
				return new Text(theme.fg("error", firstLine), 0, 0);
			}

			const isGh = details?.via === "gh";
			const status = details?.status;
			const statusStyled = isGh
				? theme.fg("success", "gh")
				: status === undefined
					? theme.fg("muted", "HTTP ?")
					: status >= 200 && status < 300
						? theme.fg("success", `HTTP ${status}`)
						: status >= 300 && status < 400
							? theme.fg("warning", `HTTP ${status}`)
							: theme.fg("error", `HTTP ${status}`);

			const sep = theme.fg("dim", " · ");
			const parts: string[] = [statusStyled];
			if (isGh) {
				if (details?.ghCommand) parts.push(theme.fg("muted", details.ghCommand));
			} else if (details?.contentType) {
				parts.push(theme.fg("muted", details.contentType.split(";")[0].trim()));
			}
			if (typeof details?.bytes === "number") {
				let sizeText = formatSize(details.bytes);
				if (details.truncated) sizeText += " (truncated)";
				parts.push(theme.fg("dim", sizeText));
			}
			if (details?.category === "binary") {
				parts.push(theme.fg("warning", "binary → file"));
			} else if (details?.spilled) {
				parts.push(theme.fg("warning", "→ file"));
			}

			let text = parts.join(sep);

			if (!expanded) {
				const lineCount = details?.lines ?? (fullText ? fullText.split("\n").length : 0);
				if (lineCount > 0) {
					text += sep + theme.fg("dim", `${lineCount} lines`);
				}
				text += " " + theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`);
				return new Text(text, 0, 0);
			}

			if (fullText) {
				for (const line of fullText.split("\n")) {
					text += `\n${theme.fg("toolOutput", line)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}
