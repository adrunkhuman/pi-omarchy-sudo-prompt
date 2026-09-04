const prefix = String.raw`(?:if|then|elif|else|while|until|do|time|command|exec|nohup|setsid|env)\s+|[A-Za-z_]\w*=\S+\s+`;
const executable = String.raw`(?:\S+/)?(?:sudoedit|sudo|doas|pkexec|su)(?=$|[\s<>])`;
const privilegeCommand = new RegExp(`^(?:${prefix})*${executable}`);

type ToolCall = { toolName: string; input: unknown };

export function commandCarrier(event: ToolCall): string | undefined {
	if (!event.input || typeof event.input !== "object") return undefined;
	const input = event.input as Record<string, unknown>;

	if (event.toolName === "bash" && typeof input.command === "string") return input.command;
	if (event.toolName !== "herdr") return undefined;
	if (input.action === "run" && typeof input.command === "string") return input.command;
	if (input.action === "send" && typeof input.text === "string") return input.text;
	return undefined;
}

export function hasPrivilegeCommand(command: string): boolean {
	return command.split(/[;&|()`\n]/).some((part) => privilegeCommand.test(part.trimStart()));
}
