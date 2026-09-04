import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { commandCarrier, hasPrivilegeCommand } from "./detection.ts";
import { ensureOmarchyUi, IPC_TARGET } from "./install-omarchy.ts";
import { requestSettings } from "./monitor.ts";

const TOOL_NAME = "privileged_exec";
const ROOT_TIMEOUT_SECONDS = 10 * 60;
const EXECUTION_TIMEOUT_MS = (ROOT_TIMEOUT_SECONDS + 10) * 1_000;
const RETRY_MESSAGE =
	"Privileged command blocked. Use privileged_exec with the exact command (without sudo/pkexec), reason, and impact.";

interface ApprovalState {
	id: string;
	state: "pending" | "allow" | "deny";
	reason?: string;
	feedback?: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseJson<T>(text: string, context: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${context} returned an invalid response: ${text || "<empty>"}`);
	}
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Cancelled"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function combinedOutput(stdout: string, stderr: string): string {
	const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
	if (!output) return "Command completed without output.";

	const truncated = truncateTail(output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	return truncated.truncated
		? `${truncated.content}\n\n[Output truncated to the last ${truncated.outputLines} lines / ${truncated.outputBytes} bytes.]`
		: truncated.content;
}

export default function (pi: ExtensionAPI) {
	let setup: Promise<void> | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = queue.then(operation, operation);
		queue = result.then(() => undefined, () => undefined);
		return result;
	}

	async function prepareUi(): Promise<void> {
		if (setup) return setup;
		const current = ensureOmarchyUi(pi);
		setup = current;
		try {
			await current;
		} catch (error) {
			if (setup === current) setup = undefined;
			throw error;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			await prepareUi();
		} catch (error) {
			ctx.ui.notify(`privileged_exec unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	async function ipc(method: string, argument: string, signal?: AbortSignal): Promise<string> {
		const result = await pi.exec("omarchy-shell", [IPC_TARGET, method, argument], {
			signal,
			timeout: 5_000,
		});
		if (result.code !== 0) {
			throw new Error(
				`Privilege approval screen is unavailable: ${result.stderr.trim() || `omarchy-shell exited ${result.code}`}`,
			);
		}
		return result.stdout.trim();
	}

	async function requestApproval(
		params: { command: string; reason: string; impact: string },
		cwd: string,
		signal?: AbortSignal,
	): Promise<ApprovalState> {
		const id = crypto.randomUUID();
		const settings = await requestSettings(pi);
		const payload = JSON.stringify({
			id,
			command: params.command,
			reason: params.reason,
			impact: params.impact,
			cwd,
			monitorName: settings.monitorName,
			timeoutMs: settings.timeoutMs,
			executionTimeoutMs: EXECUTION_TIMEOUT_MS,
		});
		const acknowledgement = parseJson<{ accepted?: boolean; state?: string }>(
			await ipc("request", payload, signal),
			"Privilege approval screen",
		);
		if (!acknowledgement.accepted) {
			throw new Error(`Privilege approval screen rejected the request (${acknowledgement.state ?? "unknown"}).`);
		}

		const deadline = Date.now() + settings.timeoutMs + 2_000;
		try {
			while (Date.now() < deadline) {
				await abortableDelay(250, signal);
				const state = parseJson<ApprovalState>(await ipc("state", id, signal), "Privilege approval screen");
				if (state.state !== "pending") return state;
			}
			return { id, state: "deny", reason: "timeout" };
		} catch (error) {
			await ipc("dismiss", id).catch(() => undefined);
			throw error;
		}
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Privileged Exec",
		description:
			"Request approval and run a command as root through Omarchy's graphical privilege flow. Provide the exact command without sudo, pkexec, doas, or su, plus a concise reason and impact. The user sees all three before approval.",
		promptSnippet: "Run an explicitly explained command with root privileges after graphical user approval",
		promptGuidelines: [
			"Use privileged_exec instead of sudo, pkexec, doas, or su whenever a command needs root privileges; provide the exact command without an elevation wrapper and explain its reason and impact.",
		],
		parameters: Type.Object({
			command: Type.String({
				minLength: 1,
				maxLength: 8_000,
				description: "Exact shell command to run as root, without sudo, pkexec, doas, or su",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: 1_000,
				description: "Why root privileges are required",
			}),
			impact: Type.String({
				minLength: 1,
				maxLength: 1_000,
				description: "What system state the command may change",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (hasPrivilegeCommand(params.command)) {
				throw new Error("command must not contain sudo, pkexec, doas, or su; privileged_exec adds elevation itself");
			}
			await prepareUi();

			return serialize(async () => {
				pi.events.emit("herdr:blocked", { active: true, label: "privilege approval" });
				let approvalId: string | undefined;
				try {
					const approval = await requestApproval(params, ctx.cwd, signal);
					approvalId = approval.id;
					if (approval.state !== "allow") {
						const feedback = approval.feedback?.trim();
						throw new Error(
							feedback
								? `Privilege request denied. User feedback: ${feedback}`
								: `Privilege request denied (${approval.reason ?? "user"}).`,
						);
					}

					const wrappedCommand = `cd -- ${shellQuote(ctx.cwd)} && ${params.command}`;
					const result = await pi.exec(
						"pkexec",
						[
							"/usr/bin/timeout",
							"--kill-after=5s",
							`${ROOT_TIMEOUT_SECONDS}s`,
							"/usr/bin/bash",
							"-c",
							wrappedCommand,
						],
						{ timeout: EXECUTION_TIMEOUT_MS, cwd: ctx.cwd },
					);
					const output = combinedOutput(result.stdout, result.stderr);
					if (result.code !== 0) throw new Error(`Privileged command exited ${result.code}.\n${output}`);

					return {
						content: [{ type: "text" as const, text: output }],
						details: {
							command: params.command,
							reason: params.reason,
							impact: params.impact,
							exitCode: result.code,
						},
					};
				} finally {
					if (approvalId) await ipc("dismiss", approvalId).catch(() => undefined);
					pi.events.emit("herdr:blocked", { active: false });
				}
			});
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("privileged_exec"))} ${theme.fg("muted", args.reason)}\n${theme.fg("dim", args.command)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const exitCode = (result.details as { exitCode?: number } | undefined)?.exitCode;
			const status = exitCode === 0 ? theme.fg("success", "approved and completed") : theme.fg("error", "not completed");
			const output = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
			return new Text(`${status}\n${output}`, 0, 0);
		},
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === TOOL_NAME) return undefined;
		const command = commandCarrier(event);
		return command && hasPrivilegeCommand(command) ? { block: true, reason: RETRY_MESSAGE } : undefined;
	});
}
