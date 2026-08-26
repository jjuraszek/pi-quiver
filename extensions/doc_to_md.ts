/**
 * doc_to_md Extension
 *
 * Registers a `doc_to_md` tool that converts a local PDF, DOCX, or PPTX file
 * to Markdown. Primary engine: pymupdf4llm via ephemeral `uv run --with`
 * (warm-once per process, no repo venv). Fallback: unpdf pure-JS text
 * extraction (degraded, explicitly marked). DOCX/PPTX convert to PDF first
 * via headless soffice, then feed the PDF pipeline. Output over 32 KB or
 * 1000 lines is spilled to a temp .md file with a 60-line preview; smaller
 * content is returned inline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { convertDocument, parseConfig, type DocToMdDetails } from "../lib/doc-to-md-core.ts";

export default function docToMdExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "doc_to_md",
		label: "Convert doc to Markdown",
		description:
			"Convert a local PDF/DOCX/PPTX file to Markdown. High-fidelity conversion via pymupdf4llm, resolved per process: uv (pinned, isolated) when available, else a system Python >= 3.12 with pymupdf4llm already installed, else a one-time managed venv bootstrapped into the user cache dir; falls back to a degraded pure-JS text extractor (unpdf) when no capable Python exists or conversion fails. DOCX/PPTX require LibreOffice (soffice) for the office->PDF step. Output over 32KB or 1000 lines is written to a temp .md file with a preview instead of inlined - grep it or read with offset/limit. A degraded result (marked in the output) means the fallback ran: tables and headings are NOT faithfully preserved, treat structure with suspicion. Input must be a local file path (use fetch first for URLs).",
		promptSnippet: "Convert a local PDF/DOCX/PPTX to Markdown",
		parameters: Type.Object({
			path: Type.String({ description: "Local path to a .pdf, .docx, or .pptx file" }),
		}),

		async execute(_toolCallId, params, signal) {
			const cfg = parseConfig(process.env);
			const { output, details } = await convertDocument(params.path, cfg, signal);
			return { content: [{ type: "text" as const, text: output }], details };
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("doc_to_md "));
			text += theme.fg("accent", args.path ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Converting..."), 0, 0);
			}

			const details = result.details as DocToMdDetails | undefined;
			const content = result.content[0];
			const fullText = content?.type === "text" ? content.text : "";

			if (context.isError) {
				const firstLine = fullText.split("\n")[0] || "doc_to_md failed";
				return new Text(theme.fg("error", firstLine), 0, 0);
			}

			const sep = theme.fg("dim", " · ");
			const parts: string[] = [];
			parts.push(theme.fg("muted", details?.inputType ?? "?"));
			parts.push(
				details?.degraded
					? theme.fg("warning", "unpdf (degraded)")
					: theme.fg("muted", "pymupdf4llm"),
			);
			parts.push(theme.fg("dim", formatSize(details?.bytes ?? 0)));
			if (details?.spilled) parts.push(theme.fg("warning", "→ file"));

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
