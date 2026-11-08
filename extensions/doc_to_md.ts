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
import { publicHandle } from "../lib/doc-to-md-handle.ts";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const strings = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const pages = Type.Array(Type.Integer());
const pageStrings = Type.Record(Type.Number(), Type.String());
const inputType = strings(["pdf", "docx", "doc", "pptx", "xlsx", "xlsm", "xls", "html", "image", "email"]);
const tocEntry = { level: Type.Integer(), title: Type.String(), page: nullable(Type.Integer()) };
const ocrSchema = Type.Object({
	status: strings(["off", "unavailable", "skipped", "ran"]), lang: Type.String(),
	textless: pages, pages, noText: pages, ocrFailed: pages, budgetStopped: pages, ceilingStopped: pages,
	ocrMaxPages: Type.Integer(), reason: nullable(Type.String()), tesseract: nullable(Type.Boolean()),
	mode: strings(["textless", "all"]), sidecars: pageStrings, wordSidecars: pageStrings, ocrErrors: pageStrings,
	killed: nullable(Type.Integer()), notAttempted: pages, childError: nullable(Type.String()),
});
const sheetSchema = Type.Object({
	index: Type.Integer(), name: Type.String(), kind: strings(["worksheet", "chartsheet"]), hidden: Type.Boolean(),
	rows: nullable(Type.Integer()), cols: nullable(Type.Integer()), hiddenRows: Type.Integer(), hiddenCols: Type.Integer(),
	charts: Type.Integer(), images: Type.Integer(), rendered: Type.Boolean(), csv: nullable(Type.String()),
});
const outputSchema = Type.Union([
	Type.Object({
		savedTo: Type.String(), imagesDir: nullable(Type.String()), sheetsDir: nullable(Type.String()), pagesDir: nullable(Type.String()),
		type: inputType,
		engine: strings(["pymupdf4llm", "pymupdf-text", "unpdf", "openpyxl", "xlrd", "mammoth", "python-docx", "markdownify", "turndown", "copy", "extract-msg", "email"]),
		tier: strings(["primary", "fallback", "unpdf", "excel", "docx", "html", "image", "email"]),
		pageCount: nullable(Type.Integer()), pages: nullable(pages), explicitBreaks: nullable(Type.Integer()),
		imageCount: Type.Integer(), pageImageCount: Type.Integer(), pageImagesReason: nullable(Type.String()), bytes: Type.Integer(), lines: Type.Integer(),
		degraded: nullable(Type.String()), fallbackReason: nullable(Type.String()), failedPages: pages, emptyPages: pages,
		notes: Type.Array(Type.String()), outline: Type.Array(Type.Object({ line: Type.Integer(), ...tocEntry })), outlineTotal: Type.Integer(), ocr: nullable(ocrSchema),
		pageStats: nullable(Type.Array(Type.Union([
			Type.Object({ page: Type.Integer(), chars: Type.Integer(), images: Type.Integer(), imageCoverage: Type.Number() }),
			Type.Object({ page: Type.Integer(), error: Type.String() }),
		]))),
		pageStatsPath: nullable(Type.String()), ocrDir: nullable(Type.String()),
		nativeImages: Type.Array(Type.Object({ page: Type.Integer(), file: Type.String(), width: Type.Integer(), height: Type.Integer() })),
		wordsPath: nullable(Type.String()), wordsReason: nullable(Type.String()), wordsErrors: pageStrings,
	}),
	Type.Object({
		type: inputType, backend: strings(["uv", "python", "venv", "none"]), pageCount: nullable(Type.Integer()),
		metadata: Type.Record(Type.String(), Type.String()), toc: Type.Array(Type.Object(tocEntry)), tocTotal: Type.Integer(),
		sheets: nullable(Type.Array(sheetSchema)), sheetsTotal: Type.Integer(),
	}),
]);

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
	for (const d of DOC_TO_MD_OPTIONS) {
		if (d.settingsOnly) continue;
		props[d.key] = d.key === "path" ? schemaFor(d) : Type.Optional(schemaFor(d));
	}
	return Type.Object(props);
}

export default function docToMdExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "doc_to_md",
		label: "Convert doc to Markdown bundle",
		description:
			"Convert a local PDF/DOCX/DOC/PPTX/XLSX/XLSM/XLS, email (.msg/.eml), HTML (.html/.htm) or image (.png .jpg .jpeg .tif .tiff .bmp .gif) to a Markdown bundle on disk and return a handle (Saved-To, Images-Dir, Page-Count, Outline, diagnostics) - the Markdown itself is never inlined; read the Saved-To file (offset/limit) for content. `info: true` returns page count, metadata and TOC (or the sheet inventory) without converting - use it to pick `pages`. `pages` selects inclusive 1-based pages (PDF/PPTX) or explicit-page-break segments (DOCX; rejected when the file has none); every selected PDF/PPTX page or DOCX segment when `pageCount > 1` ends with `--- end of page.page_number=N ---`. Images are always extracted into images/ with relative links. Primary engine pymupdf4llm, fallback PyMuPDF text (degraded, marked), pure-JS unpdf only when no Python backend exists. Excel yields a sheet inventory (worksheets + chartsheets), a full CSV per non-empty worksheet under sheets/, a bounded preview with formulas and cached values, merged/hidden disclosure, and rendered chart views when LibreOffice is available. DOCX converts directly (mammoth; python-docx text fallback) and keeps heading styles, so the handle Outline lists `L<line>` and `p<segment>` per heading; LibreOffice (soffice) is optional for DOCX (fallback route, degraded) and Excel rendered views, and required for PPTX. Use `outputDir` for a durable bundle; without it the bundle lands in a per-call temp dir. Input must be a local file path (use fetch first for URLs). HTML converts without Readability (markdownify; Turndown fallback): local and data: images are copied into images/, remote images stay links. Pages without a text layer keep their picture in images/, or pages/ with `pageImages: true`; image inputs keep their picture in images/. `pageImages: true` writes page renders to pages/<stem>-pNNN, and email attachments are saved under attachments/. OCR is off by default: `ocr: true` adds recognized text (labeled as OCR) when Tesseract language data is installed; the handle's OCR: line says what ran. Two-pass OCR: read Page-Stats first, then re-run with ocr: true, ocrMode: \"all\" and an explicit pages selection to get ocr/ sidecars for the pages you name. OCR is capped at quiver.docToMd.ocrMaxPages pages per call (default 10; settings-only, no tool parameter): ocrMode \"all\" rejects a larger distinct-page selection before any work, and textless mode OCRs the first ocrMaxPages textless pages and names the rest in the OCR: line with the pages to rerun.",
		promptSnippet: "Convert a local PDF/DOCX/DOC/PPTX/XLSX/XLSM/XLS/MSG/EML/HTML/image to a Markdown bundle (handle returned; read Saved-To)",
		parameters: buildSchema(),
		outputSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const settings = resolveConfig<Partial<Tunables>>(ctx.cwd, "docToMd", {}, (raw) => coerceDocToMdSettings(raw, (m) => console.warn(m)), (m) => console.warn(m));
			const p = params as unknown as PerCallInput;
			const perCall: PerCallInput = { ...p, path: resolve(ctx.cwd, p.path), ...(p.outputDir ? { outputDir: resolve(ctx.cwd, p.outputDir) } : {}) };
			const o = resolveOptions(perCall, settings, process.env);
			const r = o.info ? await inspectDocument(o, signal) : await convertDocument(o, signal);
			return {
				content: [{ type: "text" as const, text: r.output }], details: r.details,
				structuredContent: o.info ? r.details : publicHandle(r.details as DocToMdDetails),
			};
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
