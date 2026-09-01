// Pi-free Herdr socket client for the session-name extension's tab sink.
// One-shot newline-delimited JSON RPC against Herdr's unix socket (protocol
// 20, herdr 0.8.2). Every failure mode resolves null: a dead, wedged, or
// absent Herdr must never break a session or stall shutdown.
// Responses are trusted structurally: result.tab/result.tabs shapes are not
// validated beyond presence, and the consumer treats their fields as
// Herdr-provided truth.
import net from "node:net";

export interface HerdrTab {
	tab_id: string;
	workspace_id: string;
	label: string;
	number: number;
}

export function isHerdrActive(
	env: Record<string, string | undefined> = process.env,
	isTTY: boolean = process.stdout.isTTY === true,
): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_TAB_ID && !!env.HERDR_SOCKET_PATH && isTTY;
}

let nextRequestId = 1;

export function herdrRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 1500,
): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const path = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
		let settled = false;
		const timer = setTimeout(() => done(null), timeoutMs);
		const socket = net.createConnection({ path });
		const done = (value: Record<string, unknown> | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		socket.on("error", () => done(null));
		socket.on("close", () => done(null));
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id: String(nextRequestId++), method, params })}\n`);
		});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
				const result = message.result;
				if (!("error" in message) && result && typeof result === "object") {
					done(result as Record<string, unknown>);
				} else {
					done(null);
				}
			} catch {
				done(null);
			}
		});
	});
}

export async function getTab(
	socketPath: string,
	tabId: string,
	timeoutMs = 1500,
): Promise<HerdrTab | null> {
	const result = await herdrRequest(socketPath, "tab.get", { tab_id: tabId }, timeoutMs);
	const tab = result?.tab;
	return tab && typeof tab === "object" ? (tab as unknown as HerdrTab) : null;
}

export async function listTabs(socketPath: string, timeoutMs = 1500): Promise<HerdrTab[] | null> {
	const result = await herdrRequest(socketPath, "tab.list", {}, timeoutMs);
	const tabs = result?.tabs;
	return Array.isArray(tabs) ? (tabs as unknown as HerdrTab[]) : null;
}

export async function renameTab(
	socketPath: string,
	tabId: string,
	label: string,
	timeoutMs = 1500,
): Promise<true | null> {
	const result = await herdrRequest(socketPath, "tab.rename", { tab_id: tabId, label }, timeoutMs);
	return result ? true : null;
}
