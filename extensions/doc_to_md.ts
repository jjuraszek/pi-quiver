/**
 * doc_to_md Extension - converts a local PDF/DOCX/PPTX/XLSX/XLS to a Markdown bundle on disk
 * (<stem>.md + images/) and returns a bounded handle; `info: true` inspects without converting.
 * Schema and settings shape derive from the core's option descriptors (single source of truth).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TObject, type TSchema } from "@sinclair/typebox";
import { resolveConfig } from "../lib/extension-config.ts";
import {
	DOC_TO_MD_OPTIONS, type DocToMdDetails, type OptionDescriptor, type PerCallInput, type Tunables,
	coerceDocToMdSettings, convertDocument, inspectDocument, resolveOptions,
} from "../lib/doc-to-md-core.ts";
import { resolve } from "node:path";

function schemaFor(d: OptionDescriptor): TSchema {
	const desc = { description: d.help };
	switch (d.type) {
		case "bool": return Type.Boolean(desc);
		case "int": return Type.Integer({ ...desc, minimum: 1 });
		case "enum": return Type.Union(d.enumValues!.map((v) => Type.Literal(v)), desc);
		default: return Type.String(desc);
	}
}

function buildSchema(): TObject {
	const props: Record<string, TSchema> = {};
	for (const d of DOC_TO_MD_OPTIONS) props[d.key] = d.key === "path" ? schemaFor(d) : Type.Optional(schemaFor(d));
	return Type.Object(props);
}

export default function docToMdExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "doc_to_md",
		label: "Convert doc to Markdown bundle",
		description:
			"Convert a local PDF/DOCX/PPTX/XLSX/XLS to a Markdown bundle on disk and return a handle (Saved-To, Images-Dir, Page-Count, Outline, diagnostics) - the Markdown itself is never inlined; read the Saved-To file (offset/limit) for content. `info: true` returns page count, metadata and TOC (or the sheet inventory) without converting - use it to pick `pages`. `pages` selects inclusive 1-based pages (PDF/DOCX/PPTX); every page ends with `--- end of page.page_number=N ---`. Images are always extracted into images/ with relative links. Primary engine pymupdf4llm, fallback PyMuPDF text (degraded, marked), pure-JS unpdf only when no Python backend exists. Excel yields a sheet inventory (worksheets + chartsheets), a full CSV per non-empty worksheet under sheets/, a bounded preview with formulas and cached values, merged/hidden disclosure, and rendered chart views when LibreOffice is available. DOCX/PPTX need LibreOffice (soffice). Use `outputDir` for a durable bundle; without it the bundle lands in a per-call temp dir. Input must be a local file path (use fetch first for URLs).",
		promptSnippet: "Convert a local PDF/DOCX/PPTX/XLSX to a Markdown bundle (handle returned; read Saved-To)",
		parameters: buildSchema(),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const settings = resolveConfig<Partial<Tunables>>(ctx.cwd, "docToMd", {}, (raw) => coerceDocToMdSettings(raw, (m) => console.warn(m)), (m) => console.warn(m));
			const p = params as unknown as PerCallInput;
			const perCall: PerCallInput = { ...p, path: resolve(ctx.cwd, p.path), ...(p.outputDir ? { outputDir: resolve(ctx.cwd, p.outputDir) } : {}) };
			const o = resolveOptions(perCall, settings, process.env);
			const r = o.info ? await inspectDocument(o, signal) : await convertDocument(o, signal);
			return { content: [{ type: "text" as const, text: r.output }], details: r.details };
		},

		renderCall(args, theme) {
			const p = args as unknown as PerCallInput;
			let text = theme.fg("toolTitle", theme.bold(p.info ? "doc_to_md --info " : "doc_to_md "));
			text += theme.fg("accent", p.path ?? "");
			if (p.pages) text += theme.fg("dim", ` pages ${p.pages}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Converting..."), 0, 0);
			const content = result.content[0];
			const fullText = content?.type === "text" ? content.text : "";
			if (context.isError) return new Text(theme.fg("error", fullText.split("\n")[0] || "doc_to_md failed"), 0, 0);
			const d = result.details as Partial<DocToMdDetails> | undefined;
			const sep = theme.fg("dim", " · ");
			const parts = [theme.fg("muted", d?.type ?? "?")];
			if (d?.engine) parts.push(d.degraded ? theme.fg("warning", `${d.engine} (degraded)`) : theme.fg("muted", d.engine));
			if (d?.pages !== undefined) parts.push(theme.fg("dim", d.pages ? `${d.pages.length} pages` : "all pages"));
			if (d?.imageCount !== undefined) parts.push(theme.fg("dim", `${d.imageCount} images`));
			let text = parts.join(sep);
			if (!expanded) return new Text(`${text} ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`, 0, 0);
			for (const line of fullText.split("\n")) text += `\n${theme.fg("toolOutput", line)}`;
			return new Text(text, 0, 0);
		},
	});
}
