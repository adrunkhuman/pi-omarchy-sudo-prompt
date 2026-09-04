import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IPC_TARGET = "io.github.adrunkhuman.pi-privileged-exec";
const PLUGIN_VERSION = "0.2.0";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../omarchy");
const targetDir = join(homedir(), ".config/omarchy/plugins", IPC_TARGET);
const pluginFiles = ["manifest.json", "Service.qml"] as const;

async function installFile(name: (typeof pluginFiles)[number]): Promise<boolean> {
	const source = await readFile(join(sourceDir, name));
	const target = join(targetDir, name);
	try {
		const current = await readFile(target);
		if (current.equals(source)) return false;
	} catch {
		// Treat unreadable targets as stale so installation can repair them.
	}

	// Keep the temporary file beside the target so rename is atomic.
	const temporary = `${target}.tmp-${process.pid}`;
	await writeFile(temporary, source, { mode: 0o644 });
	await rename(temporary, target);
	return true;
}

async function shellCall(pi: ExtensionAPI, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return pi.exec("omarchy-shell", args, { timeout: 5_000 });
}

async function waitForVersion(pi: ExtensionAPI, attempts = 8): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const probe = await shellCall(pi, [IPC_TARGET, "version"]);
		if (probe.code === 0 && probe.stdout.trim() === PLUGIN_VERSION) return true;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	return false;
}

export async function ensureOmarchyUi(pi: ExtensionAPI): Promise<void> {
	await access("/usr/bin/pkexec", constants.X_OK).catch(() => {
		throw new Error("pkexec is not installed");
	});

	const ping = await shellCall(pi, ["shell", "ping"]);
	if (ping.code !== 0) throw new Error("Omarchy shell is not running");

	await mkdir(targetDir, { recursive: true });
	let changed = false;
	for (const name of pluginFiles) changed = (await installFile(name)) || changed;

	if (changed) {
		const rescan = await shellCall(pi, ["shell", "rescanPlugins"]);
		if (rescan.code !== 0) throw new Error(rescan.stderr.trim() || "failed to rescan Omarchy plugins");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
	}

	// Plugin discovery is asynchronous after a rescan.
	let plugin: { id?: string; enabled?: boolean } | undefined;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const listed = await shellCall(pi, ["shell", "listPlugins"]);
		if (listed.code !== 0) throw new Error(listed.stderr.trim() || "failed to list Omarchy plugins");
		const plugins = JSON.parse(listed.stdout) as Array<{ id?: string; enabled?: boolean }>;
		plugin = plugins.find((candidate) => candidate.id === IPC_TARGET);
		if (plugin) break;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	}
	if (!plugin) throw new Error("Omarchy did not discover the privilege approval plugin");

	if (!plugin.enabled) {
		const enabled = await shellCall(pi, ["shell", "setPluginEnabled", IPC_TARGET, "true"]);
		if (enabled.code !== 0) throw new Error(enabled.stderr.trim() || "failed to enable the approval plugin");
	}

	// Service plugins can remain loaded after their files change.
	if (await waitForVersion(pi)) return;
	const restarted = await pi.exec("omarchy", ["restart", "shell"], { timeout: 15_000 });
	if (restarted.code !== 0) throw new Error(restarted.stderr.trim() || "failed to restart Omarchy shell");
	if (await waitForVersion(pi, 24)) return;
	throw new Error("Omarchy discovered the approval plugin, but its current IPC service is unavailable");
}
