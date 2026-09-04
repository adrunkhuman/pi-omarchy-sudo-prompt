const privilegeCommands = new Set(["sudo", "sudoedit", "doas", "pkexec", "su"]);
const commandPrefixes = new Set(["!", "if", "then", "elif", "else", "while", "until", "do", "time"]);
const transparentWrappers = new Set(["command", "exec", "nohup", "setsid"]);

type ToolCall = { toolName: string; input: unknown };
type ShellToken = { kind: "word" | "separator"; value: string };

export function commandCarrier(event: ToolCall): string | undefined {
	if (!event.input || typeof event.input !== "object") return undefined;
	const input = event.input as Record<string, unknown>;

	if (event.toolName === "bash" && typeof input.command === "string") return input.command;

	if (event.toolName === "herdr") {
		if (input.action === "run" && typeof input.command === "string") return input.command;
		if (input.action === "send" && typeof input.text === "string") return input.text;
	}

	return undefined;
}

function shellTokens(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let word = "";
	let quote: "single" | "double" | undefined;

	const flushWord = () => {
		if (!word) return;
		tokens.push({ kind: "word", value: word });
		word = "";
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (quote === "single") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = undefined;
			else if (char === "\\" && index + 1 < command.length) word += command[++index]!;
			else word += char;
			continue;
		}

		if (char === "'") quote = "single";
		else if (char === '"') quote = "double";
		else if (char === "\\" && index + 1 < command.length) word += command[++index]!;
		else if (char === "#" && !word) {
			while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
		} else if (/\s/.test(char)) {
			flushWord();
			if (char === "\n") tokens.push({ kind: "separator", value: char });
		} else if (";&|(){}`".includes(char)) {
			flushWord();
			tokens.push({ kind: "separator", value: char });
		} else word += char;
	}
	flushWord();
	return tokens;
}

function executableName(word: string): string {
	const command = word.split(/[<>]/, 1)[0]!;
	return command.slice(command.lastIndexOf("/") + 1);
}

function firstExecutable(words: string[]): { name: string; index: number } | undefined {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (
			commandPrefixes.has(word)
			|| /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
			|| /^(?:\d+|&)?(?:>>?|<<?|<>)/.test(word)
		) {
			index += 1;
			continue;
		}

		const name = executableName(word);
		if (!transparentWrappers.has(name) && name !== "env" && name !== "nice" && name !== "timeout") {
			return { name, index };
		}

		index += 1;
		if (name === "command" && words[index] && /^-[^-]*[vV]/.test(words[index]!)) return undefined;
		if (name === "nice") {
			while (index < words.length && words[index]!.startsWith("-")) {
				const takesValue = words[index] === "-n" || words[index] === "--adjustment";
				index += takesValue ? 2 : 1;
			}
			continue;
		}
		if (name === "timeout") {
			while (index < words.length && words[index]!.startsWith("-")) {
				const takesValue = words[index] === "-k" || words[index] === "--kill-after"
					|| words[index] === "-s" || words[index] === "--signal";
				index += takesValue ? 2 : 1;
			}
			index += 1;
			continue;
		}
		if (name === "env") {
			while (index < words.length && words[index]!.startsWith("-")) {
				const takesValue = words[index] === "-u" || words[index] === "--unset"
					|| words[index] === "-C" || words[index] === "--chdir"
					|| words[index] === "-S" || words[index] === "--split-string";
				index += takesValue ? 2 : 1;
			}
			while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
		} else {
			while (index < words.length && words[index]!.startsWith("-")) index += 1;
		}
	}
	return undefined;
}

function segmentHasPrivilegeCommand(words: string[]): boolean {
	for (let start = 0; start < words.length; start += 1) {
		if (start > 0 && !commandPrefixes.has(words[start - 1]!)) continue;
		const executable = firstExecutable(words.slice(start));
		if (!executable) continue;
		if (privilegeCommands.has(executable.name)) return true;

		if (["bash", "sh", "zsh"].includes(executable.name)) {
			const shellWords = words.slice(start + executable.index + 1);
			const commandFlag = shellWords.findIndex((word) => /^-[^-]*c/.test(word));
			let nestedIndex = commandFlag + 1;
			if (shellWords[nestedIndex] === "--") nestedIndex += 1;
			const nestedCommand = shellWords[nestedIndex];
			if (commandFlag >= 0 && nestedCommand && hasPrivilegeCommand(nestedCommand)) return true;
		}
	}
	return false;
}

function embeddedCommands(command: string): string[] {
	const embedded: string[] = [];
	let quote: "single" | "double" | undefined;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "'" && quote !== "double") {
			quote = quote === "single" ? undefined : "single";
			continue;
		}
		if (char === '"' && quote !== "single") {
			quote = quote === "double" ? undefined : "double";
			continue;
		}
		if (quote === "single") continue;

		if (char === "`") {
			const end = command.indexOf("`", index + 1);
			if (end >= 0) {
				embedded.push(command.slice(index + 1, end));
				index = end;
			}
			continue;
		}
		if (char !== "$" || command[index + 1] !== "(") continue;

		let depth = 1;
		let nestedQuote: "single" | "double" | undefined;
		const start = index + 2;
		let end = start;
		for (; end < command.length && depth > 0; end += 1) {
			const nested = command[end]!;
			if (nested === "\\") {
				end += 1;
				continue;
			}
			if (nested === "'" && nestedQuote !== "double") nestedQuote = nestedQuote === "single" ? undefined : "single";
			else if (nested === '"' && nestedQuote !== "single") nestedQuote = nestedQuote === "double" ? undefined : "double";
			else if (!nestedQuote && nested === "(") depth += 1;
			else if (!nestedQuote && nested === ")") depth -= 1;
		}
		if (depth === 0) {
			embedded.push(command.slice(start, end - 1));
			index = end - 1;
		}
	}
	return embedded;
}

export function hasPrivilegeCommand(command: string): boolean {
	if (embeddedCommands(command).some((embedded) => hasPrivilegeCommand(embedded))) return true;

	let segment: string[] = [];
	for (const token of shellTokens(command)) {
		if (token.kind === "word") {
			segment.push(token.value);
			continue;
		}
		if (segmentHasPrivilegeCommand(segment)) return true;
		segment = [];
	}
	return segmentHasPrivilegeCommand(segment);
}
