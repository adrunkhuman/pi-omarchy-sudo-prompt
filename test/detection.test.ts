import assert from "node:assert/strict";
import test from "node:test";
import { commandCarrier, hasPrivilegeCommand } from "../extension/detection.ts";

const privileged = [
	"sudo pacman -Syu",
	"sudoedit /etc/hosts",
	"cd /tmp && /usr/bin/pkexec id",
	"FOO=bar doas install file /usr/local/bin/file",
	"if sudo -n true; then echo cached; fi",
	"env FOO=bar sudo systemctl restart example",
	"bash -c 'printf before; sudo id'",
	"echo `sudo id`",
	"echo \"$(sudo id)\"",
	"echo \"`sudo id`\"",
	"sudo>/tmp/out id",
];

const ordinary = [
	"command -v pkexec",
	"echo sudo",
	"rg 'sudo|pkexec' logfile",
	"printf '%s\\n' sudo",
	"echo ok # sudo is only a comment",
	"cat /etc/sudoers",
];

for (const command of privileged) {
	test(`detects ${command}`, () => assert.equal(hasPrivilegeCommand(command), true));
}

for (const command of ordinary) {
	test(`allows ${command}`, () => assert.equal(hasPrivilegeCommand(command), false));
}

test("extracts bash commands", () => {
	assert.equal(commandCarrier({ toolName: "bash", input: { command: "sudo id" } }), "sudo id");
});

test("extracts Herdr run commands", () => {
	assert.equal(commandCarrier({ toolName: "herdr", input: { action: "run", command: "sudo id" } }), "sudo id");
});

test("extracts Herdr send text", () => {
	assert.equal(commandCarrier({ toolName: "herdr", input: { action: "send", text: "sudo id" } }), "sudo id");
});

test("ignores non-command Herdr actions", () => {
	assert.equal(commandCarrier({ toolName: "herdr", input: { action: "read" } }), undefined);
});
