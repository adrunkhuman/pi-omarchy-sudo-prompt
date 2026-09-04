import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { CONFIG_PATH } from "./install-omarchy.ts";

type Client = { pid?: number; monitor?: number };
type Monitor = { id?: number; name?: string };

async function ancestors(pid: number): Promise<number[]> {
	const result: number[] = [];
	const seen = new Set<number>();

	while (pid > 1 && !seen.has(pid)) {
		seen.add(pid);
		result.push(pid);
		const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
		pid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
	}
	return result;
}

function monitorFor(pids: number[], clients: Client[], monitors: Monitor[]): string | undefined {
	for (const pid of pids) {
		const monitorId = clients.find((client) => client.pid === pid)?.monitor;
		const name = monitors.find((monitor) => monitor.id === monitorId)?.name;
		if (name) return name;
	}
	return undefined;
}

export async function piMonitorName(pi: ExtensionAPI): Promise<string | undefined> {
	const config: unknown = await readFile(CONFIG_PATH, "utf8").then(JSON.parse).catch(() => ({}));
	if (!config || typeof config !== "object" || (config as { monitor?: string }).monitor !== "pi") return undefined;

	try {
		const [clientResult, monitorResult] = await Promise.all([
			pi.exec("hyprctl", ["-j", "clients"], { timeout: 2_000 }),
			pi.exec("hyprctl", ["-j", "monitors"], { timeout: 2_000 }),
		]);
		if (clientResult.code !== 0 || monitorResult.code !== 0) return undefined;

		const clients = JSON.parse(clientResult.stdout) as Client[];
		const monitors = JSON.parse(monitorResult.stdout) as Monitor[];
		const direct = monitorFor(await ancestors(process.pid), clients, monitors);
		if (direct || process.env.HERDR_ENV !== "1") return direct;

		const processes = await pi.exec("pgrep", ["-x", "herdr"], { timeout: 2_000 });
		for (const pid of processes.stdout.split("\n").map(Number).filter(Boolean)) {
			const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
			if (argv.split("\0")[1] === "server") continue;
			const name = monitorFor(await ancestors(pid), clients, monitors);
			if (name) return name;
		}
	} catch {
		// The active monitor is the fallback when Pi's window cannot be identified.
	}
	return undefined;
}
