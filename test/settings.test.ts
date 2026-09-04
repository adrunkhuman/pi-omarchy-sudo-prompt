import assert from "node:assert/strict";
import test from "node:test";
import { parseSettings } from "../extension/monitor.ts";

test("uses defaults for missing settings", () => {
	assert.deepEqual(parseSettings(null), { monitor: "active", timeoutSeconds: 120 });
});

test("accepts Pi monitor and a custom timeout", () => {
	assert.deepEqual(parseSettings({ monitor: "pi", timeoutSeconds: 45 }), {
		monitor: "pi",
		timeoutSeconds: 45,
	});
});

test("enforces the minimum timeout", () => {
	assert.equal(parseSettings({ timeoutSeconds: 1 }).timeoutSeconds, 5);
});

test("rejects invalid timeout values", () => {
	assert.equal(parseSettings({ timeoutSeconds: "45" }).timeoutSeconds, 120);
});
