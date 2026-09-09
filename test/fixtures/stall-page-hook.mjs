import { register } from "node:module";

const loader = String.raw`
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
	if (specifier !== "unpdf") return nextResolve(specifier, context);
	const resolved = await nextResolve(specifier, context);
	return { url: "stall-page-hook:" + encodeURIComponent(resolved.url), shortCircuit: true };
}

export async function load(url, context, nextLoad) {
	if (!url.startsWith("stall-page-hook:")) return nextLoad(url, context);
	const realUrl = decodeURIComponent(url.slice("stall-page-hook:".length));
	const source = [
		"import { appendFileSync } from \"node:fs\";",
		"import * as real from " + JSON.stringify(realUrl) + ";",
		"export * from " + JSON.stringify(realUrl) + ";",
		"export async function getDocumentProxy(...args) {",
		"  const pdf = await real.getDocumentProxy(...args);",
		"  const getPage = pdf.getPage.bind(pdf);",
		"  return new Proxy(pdf, { get(target, property, receiver) {",
		"    if (property !== \"getPage\") return Reflect.get(target, property, receiver);",
		"    return (page) => {",
		"      appendFileSync(process.env.PAGE_LOG, String(Number(page)) + \"\\n\");",
		"      if (Number(page) === Number(process.env.STALL_PAGE)) return new Promise(() => { setInterval(() => {}, 1_000); });",
		"      return getPage(page);",
		"    };",
		"  }});",
		"}",
	].join("\n");
	return { format: "module", source, shortCircuit: true };
}
`;

register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
