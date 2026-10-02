import type { InputType, OcrMode } from "./doc-to-md-options.ts";

export type Tier = "primary" | "fallback" | "unpdf" | "excel" | "docx" | "html" | "image" | "email";
export type Engine = "pymupdf4llm" | "pymupdf-text" | "unpdf" | "openpyxl" | "xlrd" | "mammoth" | "python-docx" | "markdownify" | "turndown" | "copy" | "extract-msg" | "email";
export type BackendKind = "uv" | "python" | "venv" | "none";

export interface OutlineEntry { line: number; level: number; title: string; page: number | null; }
export interface TocEntry { level: number; title: string; page: number | null; }
export interface SheetInfo {
	index: number;
	name: string;
	kind: "worksheet" | "chartsheet";
	hidden: boolean;
	rows: number | null; cols: number | null;
	hiddenRows: number; hiddenCols: number;
	charts: number; images: number;
	rendered: boolean;
	csv: string | null;
}

export type PageStat = { page: number; chars: number; images: number; imageCoverage: number } | { page: number; error: string };

export interface OcrInfo {
	status: "off" | "unavailable" | "skipped" | "ran";
	lang: string;
	textless: number[];
	pages: number[];
	noText: number[];
	ocrFailed: number[];
	budgetStopped: number[];
	reason: string | null;
	tesseract: boolean | null;
	mode: OcrMode;
	sidecars: Record<number, string>;
	wordSidecars: Record<number, string>;
	ocrErrors: Record<number, string>;
	killed: number | null;
	notAttempted: number[];
	childError: string | null;
}

export interface HandleData {
	savedTo: string; imagesDir: string | null; sheetsDir: string | null; pagesDir: string | null; type: InputType; engine: Engine; tier: Tier;
	pageCount: number | null; pages: number[] | null; explicitBreaks: number | null; imageCount: number; pageImageCount: number; pageImagesReason: string | null; bytes: number; lines: number;
	degraded: string | null; fallbackReason: string | null; failedPages: number[]; emptyPages: number[];
	notes: string[]; outline: OutlineEntry[]; outlineTotal: number; ocr: OcrInfo | null;
	pageStats: PageStat[] | null; pageStatsPath: string | null; ocrDir: string | null;
	wordsPath: string | null; wordsReason: string | null; wordsErrors: Record<number, string>;
}

export interface InfoData {
	type: InputType; backend: BackendKind; pageCount: number | null; metadata: Record<string, string>;
	toc: TocEntry[]; tocTotal: number; sheets: SheetInfo[] | null; sheetsTotal: number;
}

const TITLE_MAX = 80;
const NOTE_MAX_LINES = 5;
const NOTE_MAX_CHARS = 200;
const META_MAX_CHARS = 120;

// Deliberate local copy of the host package's formatSize - this module must stay pi-free.
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const trunc = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

export function compactRanges(nums: number[], maxEntries = 20): string {
	const sorted = [...new Set(nums)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
		i = j + 1;
	}
	if (parts.length <= maxEntries) return parts.join(", ");
	return `${parts.slice(0, maxEntries).join(", ")} (+${parts.length - maxEntries} more)`;
}

const INSTALL_HINT = "install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true";
const BARE_REASONS = ["fallback tier", "no Python backend"];

const pageList = (pages: number[]) => `page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}`;

function forcedOcrLine(ocr: OcrInfo): string {
	const clauses: string[] = [];
	if (ocr.pages.length) clauses.push(`sidecars for ${pageList(ocr.pages)}`);
	if (ocr.noText.length) clauses.push(`no text on ${pageList(ocr.noText)}`);
	for (const page of ocr.ocrFailed) clauses.push(`failed on page ${page} (${ocr.ocrErrors[page] ?? "unknown error"})`);
	if (ocr.budgetStopped.length) clauses.push(`budget-stopped ${pageList(ocr.budgetStopped)}`);
	if (ocr.killed !== null) clauses.push(`page ${ocr.killed} killed the OCR child (timeout or crash - likely a compression bomb)`);
	if (ocr.childError !== null) clauses.push(`OCR child failed before processing pages: ${ocr.childError}`);
	if (ocr.notAttempted.length) clauses.push(`${pageList(ocr.notAttempted)} not attempted`);
	const rerun = [...ocr.budgetStopped, ...ocr.notAttempted].sort((a, b) => a - b);
	return `OCR: forced (${ocr.lang}) - ${clauses.join("; ")}${rerun.length ? ` - re-run with --pages ${rerun.join(",")}` : ""}`;
}

export function ocrLine(ocr: OcrInfo, type: InputType): string {
	if (ocr.mode === "all") return forcedOcrLine(ocr);
	const image = type === "image";
	const rerun = ocr.tesseract ? "rerun with ocr=true" : INSTALL_HINT;
	switch (ocr.status) {
		case "off": return image ? `OCR: off; ${rerun}` : `OCR: off - ${ocr.textless.length} page(s) without a text layer; ${rerun}`;
		case "unavailable": {
			const reason = ocr.reason ?? "";
			const bare = BARE_REASONS.includes(reason) || reason.startsWith("OCR child failed: ");
			return `OCR: unavailable - ${reason}${bare ? "" : " (install Tesseract; see doc/doc-to-md.md)"}`;
		}
		case "skipped": return "OCR: skipped - image too small";
		case "ran": {
			const clauses = [`OCR: ${ocr.pages.length} ${image ? "image" : "page(s)"} (${ocr.lang})`];
			if (ocr.noText.length) clauses.push(`no text on pages ${compactRanges(ocr.noText)}`);
			if (ocr.ocrFailed.length) clauses.push(`${ocr.ocrFailed.length} failed and were converted without OCR`);
			if (ocr.budgetStopped.length) {
				const r = compactRanges(ocr.budgetStopped, Number.POSITIVE_INFINITY).replaceAll(", ", ",");
				clauses.push(`time budget reached for pages=${r}; rerun with pages=${r} or raise primaryTimeoutMs`);
			}
			return clauses.join("; ");
		}
	}
}

const PAGE_MARKER_RE = /^--- end of page\.page_number=(\d+) ---$/;

export function scanOutline(md: string, max: number): { entries: OutlineEntry[]; total: number } {
	const entries: OutlineEntry[] = [];
	let pending: OutlineEntry[] = [];
	let total = 0, inFence = false;
	md.split("\n").forEach((raw, i) => {
		const line = raw.replace(/\r$/, "");
		const marker = line.match(PAGE_MARKER_RE);
		if (marker) { for (const e of pending) e.page = Number(marker[1]); pending = []; return; }
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
		if (inFence) return;
		const m = line.match(/^(#{1,6}) (.*)$/);
		if (!m) return;
		total++;
		if (entries.length < max) {
			const e: OutlineEntry = { line: i + 1, level: m[1].length, title: trunc(m[2].trim(), TITLE_MAX), page: null };
			entries.push(e); pending.push(e);
		}
	});
	return { entries, total };
}

function outlineLines(entries: OutlineEntry[], total: number): string[] {
	if (total === 0) return ["Outline: none"];
	if (entries.length === 0) return [];
	const lineWidth = Math.max(3, ...entries.map((e) => `L${e.line}`.length)) + 2;
	const paged = entries.filter((e) => e.page !== null);
	const pageWidth = paged.length ? Math.max(...paged.map((e) => `p${e.page}`.length)) + 2 : 0;
	const out = ["Outline:", ...entries.map((e) => `  ${`L${e.line}`.padEnd(lineWidth)}${pageWidth ? (e.page === null ? "" : `p${e.page}`).padEnd(pageWidth) : ""}${"#".repeat(e.level)} ${trunc(e.title, TITLE_MAX)}`)];
	if (total > entries.length) out.push(`  (+${total - entries.length} more)`);
	return out;
}

function pageCountLabel(h: HandleData): string {
	const n = h.pageCount ?? "?";
	if (h.type !== "docx") return String(n);
	if (h.tier === "docx") return (h.explicitBreaks ?? 0) > 0 ? `${n} (explicit page breaks, not printed pages)` : `${n} (no explicit page breaks) - no page markers; cite by Outline line`;
	return `${n} (LibreOffice pagination)`;
}

export function formatHandle(h: HandleData): string {
	const lines = [`Saved-To: ${h.savedTo}`];
	if (h.imagesDir && h.imageCount > 0) lines.push(`Images-Dir: ${h.imagesDir}`);
	if (h.sheetsDir) lines.push(`Sheets-Dir: ${h.sheetsDir}`);
	if (h.pagesDir && h.pageImageCount > 0) lines.push(`Pages-Dir: ${h.pagesDir} (${h.pageImageCount} pages)`);
	else if (h.pageImagesReason) lines.push(`Pages-Dir: none - ${h.pageImagesReason}`);
	if (h.pageStatsPath) lines.push(`Page-Stats: ${h.pageStatsPath}`);
	if (h.wordsPath) {
		const bad = Object.keys(h.wordsErrors).map(Number).sort((a, b) => a - b);
		lines.push(`Words: ${h.wordsPath}${bad.length ? ` (extraction failed for pages ${compactRanges(bad)}: ${h.wordsErrors[bad[0]]})` : ""}`);
	} else if (h.wordsReason) lines.push(`Words: ${h.wordsReason}`);
	if (h.ocrDir) lines.push(`OCR-Dir: ${h.ocrDir}`);
	lines.push(`Type: ${h.type}   Engine: ${h.engine}   Tier: ${h.tier}`);
	lines.push(`Page-Count: ${pageCountLabel(h)}   Pages: ${h.pages ? compactRanges(h.pages) : "all"}   Images: ${h.imageCount}   Size: ${formatSize(h.bytes)} / ${h.lines} lines`);
	if (h.degraded) lines.push(`Degraded: ${h.degraded}`);
	if (h.fallbackReason) lines.push(`Fallback-Reason: ${h.fallbackReason}`);
	const fe: string[] = [];
	if (h.failedPages.length) fe.push(`Failed-Pages: ${compactRanges(h.failedPages)}`);
	if (h.emptyPages.length) fe.push(`Empty-Pages: ${compactRanges(h.emptyPages)}`);
	if (fe.length) lines.push(fe.join("    "));
	if (h.ocr) lines.push(ocrLine(h.ocr, h.type));
	h.notes.slice(0, NOTE_MAX_LINES).forEach((n, i) => lines.push(`${i === 0 ? "Notes: " : "       "}${n.startsWith("preview truncated:") ? n : trunc(n, NOTE_MAX_CHARS)}`));
	lines.push(...outlineLines(h.outline, h.outlineTotal));
	return lines.join("\n");
}

export function formatInfoHandle(i: InfoData, max: number): string {
	if (i.sheets) {
		const lines = [`Type: ${i.type}   Sheets: ${i.sheetsTotal}`];
		for (const s of i.sheets.slice(0, max)) {
			const dims = `${s.kind} rows=${s.rows ?? "-"} cols=${s.cols ?? "-"} charts=${s.charts} images=${s.images}`;
			const hidden = s.hiddenRows || s.hiddenCols ? ` hiddenRows=${s.hiddenRows} hiddenCols=${s.hiddenCols}` : "";
			lines.push(`  ${trunc(s.name, TITLE_MAX)}  ${s.hidden ? "hidden " : ""}${dims}${hidden}`);
		}
		if (i.sheetsTotal > max) lines.push(`  (+${i.sheetsTotal - max} more)`);
		return lines.join("\n");
	}
	const lines = [`Type: ${i.type}   Page-Count: ${i.pageCount ?? "?"}   Backend: ${i.backend}`];
	const meta = Object.entries(i.metadata).filter(([, v]) => v).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${trunc(v, META_MAX_CHARS)}`);
	if (meta.length) lines.push(meta.join("   "));
	if (i.toc.length) {
		lines.push("TOC:", ...i.toc.slice(0, max).map((t) => `  L${t.level} ${trunc(t.title, TITLE_MAX)} (p${t.page ?? "?"})`));
		if (i.tocTotal > max) lines.push(`  (+${i.tocTotal - max} more)`);
	} else if (i.type === "docx") lines.push("TOC: none (no heading styles found)");
	return lines.join("\n");
}
