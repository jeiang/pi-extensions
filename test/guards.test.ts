import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import codemode from "../extensions/codemode/index.ts";
import guards, { branchSwitch, commandViolation, maskSecrets, restrictedFolder, switchesBranch, switchViolation, writesInto } from "../extensions/guards/index.ts";
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

test("names the branch a switch targets and whether it creates one", () => {
	assert.deepEqual(branchSwitch("git switch feat"), { target: "feat", create: false });
	assert.deepEqual(branchSwitch("git checkout -b main2"), { target: "main2", create: true });
	assert.deepEqual(branchSwitch("git fetch && git switch --create x origin/x"), { target: "x", create: true });
	assert.deepEqual(branchSwitch("git checkout \"my branch\""), { target: "my branch", create: false });
	assert.equal(branchSwitch("git checkout -- src/a.ts"), undefined);
});

test("branch switches need the user only in the main checkout or onto the default branch", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "guards-repo-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
	const linked = join(dir, ".worktrees", "feat");
	git("worktree", "add", "-q", "-b", "feat", linked);
	git("branch", "other");
	assert.ok(switchViolation("git switch other", dir), "main checkout");
	assert.equal(switchViolation("git switch other", linked), undefined);
	assert.equal(switchViolation("git checkout -b main-fix", linked), undefined);
	assert.ok(switchViolation("git switch main", linked), "default branch in a worktree");
	assert.ok(switchViolation("git checkout master", linked), "master counts as default");
	assert.equal(switchViolation("git status", dir), undefined);
});

test("finds writes into a folder, not reads from it", () => {
	for (const command of ["echo x > /etc/hosts", "sudo tee -a /etc/hosts", "cp a.conf /etc/nix/nix.conf", "sed -i s/a/b/ /etc/hosts", "rm -f /etc/foo", "dd if=x of=/etc/x"]) {
		assert.equal(writesInto(command, "/etc"), true, command);
	}
	for (const command of ["cat /etc/hosts", "cp /etc/hosts /tmp/hosts", "grep -r nix /etc/nix", "ls /etc", "sed -n 1,5p /etc/hosts", "diff /etc/a /etc/b > /tmp/out"]) {
		assert.equal(writesInto(command, "/etc"), false, command);
	}
});

test("finds restricted folders for relative and home paths", () => {
	assert.equal(restrictedFolder("~/.ssh/id_ed25519", "/tmp"), "~/.ssh");
	assert.equal(restrictedFolder(".ssh/config", homedir()), "~/.ssh");
	assert.equal(restrictedFolder("/etc/hosts", "/tmp"), "/etc");
	assert.equal(restrictedFolder("~/.sshd", "/tmp"), undefined);
	assert.equal(restrictedFolder("src/etc/file", "/repo"), undefined);
});

test("a script reads /etc freely, but a write there and a read of ~/.ssh are blocked without a user to ask", async () => {
	const results: string[] = [];
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((_m, context, i): Reply => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") results.push(last.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
				const code = [
					'const read = await tools.read_text({ path: "/etc/hosts" }).then(() => "read ok", (e) => e.message);',
					'const write = await tools.write({ path: "/etc/pi-guard-test", content: "" }).then(() => "wrote", (e) => e.message);',
					'const ssh = await tools.read_text({ path: "~/.ssh/config" }).then(() => "read", (e) => e.message);',
					"return [read, write, ssh].join(\"\\n\");",
				].join("\n");
				return i === 0 ? { tool: "codemode", args: { code } } : { text: "done" };
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
	assert.match(results[0] ?? "", /read ok/);
	assert.match(results[0] ?? "", /No user is attached to approve it\. \/etc is restricted/);
	assert.match(results[0] ?? "", /~\/\.ssh is restricted/);
});

test("masks secrets and keeps other text", () => {
	const token = `ghp_${"a".repeat(36)}`;
	assert.equal(maskSecrets(`token=${token} ok`), "token=[redacted secret] ok");
	assert.equal(maskSecrets("sha256-abc ghp_short"), "sha256-abc ghp_short");
});
