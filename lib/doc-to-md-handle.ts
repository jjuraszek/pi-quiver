import type { InputType } from "./doc-to-md-options.ts";

export type Tier = "primary" | "fallback" | "unpdf" | "excel";
export type Engine = "pymupdf4llm" | "pymupdf-text" | "unpdf" | "openpyxl" | "xlrd";
export type BackendKind = "uv" | "python" | "venv" | "none";

export interface OutlineEntry { line: number; level: number; title: string; }
export interface TocEntry { level: number; title: string; page: number; }
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

export interface HandleData {
	savedTo: string; imagesDir: string | null; sheetsDir: string | null; type: InputType; engine: Engine; tier: Tier;
	pageCount: number | null; pages: number[] | null; imageCount: number; bytes: number; lines: number;
	degraded: string | null; fallbackReason: string | null; failedPages: number[]; emptyPages: number[];
	notes: string[]; outline: OutlineEntry[]; outlineTotal: number;
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

export function scanOutline(md: string, max: number): { entries: OutlineEntry[]; total: number } {
	const entries: OutlineEntry[] = [];
	let total = 0, inFence = false;
	md.split("\n").forEach((raw, i) => {
		const line = raw.replace(/\r$/, "");
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
		if (inFence) return;
		const m = line.match(/^(#{1,6}) (.*)$/);
		if (!m) return;
		total++;
		if (entries.length < max) entries.push({ line: i + 1, level: m[1].length, title: trunc(m[2].trim(), TITLE_MAX) });
	});
	return { entries, total };
}

function outlineLines(entries: OutlineEntry[], total: number): string[] {
	if (entries.length === 0) return [];
	const width = Math.max(5, Math.max(...entries.map((e) => `L${e.line}`.length)) + 2);
	const out = ["Outline:", ...entries.map((e) => `  ${`L${e.line}`.padEnd(width)}${"#".repeat(e.level)} ${trunc(e.title, TITLE_MAX)}`)];
	if (total > entries.length) out.push(`  (+${total - entries.length} more)`);
	return out;
}

export function formatHandle(h: HandleData): string {
	const lines = [`Saved-To: ${h.savedTo}`];
	if (h.imagesDir && h.imageCount > 0) lines.push(`Images-Dir: ${h.imagesDir}`);
	if (h.sheetsDir) lines.push(`Sheets-Dir: ${h.sheetsDir}`);
	lines.push(`Type: ${h.type}   Engine: ${h.engine}   Tier: ${h.tier}`);
	lines.push(`Page-Count: ${h.pageCount ?? "?"}   Pages: ${h.pages ? compactRanges(h.pages) : "all"}   Images: ${h.imageCount}   Size: ${formatSize(h.bytes)} / ${h.lines} lines`);
	if (h.degraded) lines.push(`Degraded: ${h.degraded}`);
	if (h.fallbackReason) lines.push(`Fallback-Reason: ${h.fallbackReason}`);
	const fe: string[] = [];
	if (h.failedPages.length) fe.push(`Failed-Pages: ${compactRanges(h.failedPages)}`);
	if (h.emptyPages.length) fe.push(`Empty-Pages: ${compactRanges(h.emptyPages)}`);
	if (fe.length) lines.push(fe.join("    "));
	h.notes.slice(0, NOTE_MAX_LINES).forEach((n, i) => lines.push(`${i === 0 ? "Notes: " : "       "}${trunc(n, NOTE_MAX_CHARS)}`));
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
		lines.push("TOC:", ...i.toc.slice(0, max).map((t) => `  L${t.level} ${trunc(t.title, TITLE_MAX)} (p${t.page})`));
		if (i.tocTotal > max) lines.push(`  (+${i.tocTotal - max} more)`);
	}
	return lines.join("\n");
}
