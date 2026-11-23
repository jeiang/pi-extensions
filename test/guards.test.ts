import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import codemode from "../extensions/codemode/index.ts";
import guards, { commandHabit, commandViolation, maskSecrets, restrictedFolder, switchesBranch } from "../extensions/guards/index.ts";
import workspace from "../extensions/workspace/index.ts";
import { createTestSession, type Reply, scriptedProviders } from "./harness.ts";

test("blocks permanent installs and history rewrites", () => {
	for (const command of [
		"brew install jq",
		"npm install -g typescript",
		"cargo install ripgrep",
		"nix profile install nixpkgs#jq",
		"nix-env -iA nixpkgs.jq",
		"pip install --user requests",
		"git commit --amend --no-edit",
		"git rebase -i HEAD~3",
		"git reset --hard origin/main",
		"git push --force-with-lease origin feat",
		"git push origin +feat",
		"cd repo && git push -f",
	]) {
		assert.ok(commandViolation(command), command);
	}
});

test("allows ordinary installs and git commands", () => {
	for (const command of [
		"npm install",
		"npm install --save-dev vitest",
		"nix shell nixpkgs#jq -c jq .",
		"git reset src/file.ts",
		"git push origin feat",
		"git push -u origin feat",
		"git commit -m 'fix: amend parser'",
	]) {
		assert.equal(commandViolation(command), undefined, command);
	}
});

test("redirects piped check output without asking, and leaves other pipes alone", () => {
	assert.ok(commandHabit("npm test 2>&1 | tail -30"));
	assert.ok(commandHabit("cargo check 2>&1 | grep -E error"));
	assert.equal(commandViolation("npm test 2>&1 | tail -30"), undefined);
	assert.equal(commandHabit("git log --oneline | head -5"), undefined);
});

test("finds branch switches in the session checkout, not file restores, other repositories, or text that mentions one", () => {
	for (const command of ["git checkout --detach origin/main", "git checkout rex-ssh", "git switch -c x", "git fetch && git checkout -b new", "git checkout \"my branch\""]) {
		assert.equal(switchesBranch(command), true, command);
	}
	for (const command of [
		"git checkout -- src/a.ts",
		"git checkout HEAD -- a.ts",
		"git worktree add --detach /tmp/x origin/main",
		"git -C /tmp/clone checkout main",
		"cd /tmp/clone && git checkout main",
		"gh pr create --body 'redirects git checkout <rev> / git switch'",
		'git commit -m "guard git switch"',
		"gh pr create --body-file - <<'EOF'\nblocks git checkout main\nEOF",
		"rg 'git switch' src",
	]) {
		assert.equal(switchesBranch(command), false, command);
	}
});

test("finds restricted folders for relative and home paths", () => {
	assert.equal(restrictedFolder("~/.ssh/id_ed25519", "/tmp"), "~/.ssh");
	assert.equal(restrictedFolder(".ssh/config", homedir()), "~/.ssh");
	assert.equal(restrictedFolder("/etc/hosts", "/tmp"), "/etc");
	assert.equal(restrictedFolder("~/.sshd", "/tmp"), undefined);
	assert.equal(restrictedFolder("src/etc/file", "/repo"), undefined);
});

test("a script's read_text into a restricted folder is blocked without a user to ask", async () => {
	const results: string[] = [];
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((_m, context, i): Reply => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") results.push(last.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
				return i === 0 ? { tool: "codemode", args: { code: 'return (await tools.read_text({ path: "/etc/hosts" })).text;' } } : { text: "done" };
			}, []),
			guards,
			workspace,
			codemode,
		],
		model: ["p1", "m"],
		settings: { defaultTools: ["+codemode"] },
	});
	await session.prompt("go");
	session.dispose();
	assert.match(results[0] ?? "", /\/etc is restricted/);
});

test("masks secrets and keeps other text", () => {
	const token = `ghp_${"a".repeat(36)}`;
	assert.equal(maskSecrets(`token=${token} ok`), "token=[redacted secret] ok");
	assert.equal(maskSecrets("sha256-abc ghp_short"), "sha256-abc ghp_short");
});
