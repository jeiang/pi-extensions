import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { connectionFlags, quote, remoteCommand, sessionFlags, sshOptions } from "../extensions/workspace/ssh.ts";

const bash = (script: string) => execFileSync("bash", ["-c", script], { encoding: "utf8" });

test("option values and commands reach ssh as single arguments, never as local shell code", () => {
	const hostile = ["x'; touch /tmp/pwned; '", "$(id)", "a\\b \"c\"", "`id`"];
	assert.deepEqual(bash(`printf '%s\\0' ${hostile.map(quote).join(" ")}`).split("\0").slice(0, -1), hostile);
	assert.deepEqual(sshOptions({ User: "deploy", Compression: true }), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "User=deploy", "-o", "Compression=yes"]);
	assert.throws(() => sshOptions({ controlpath: "/tmp/x" }), /managed by the ssh tool/);
	for (const key of ["ProxyCommand", "localcommand", "PermitLocalCommand", "KnownHostsCommand", "RemoteCommand", "PKCS11Provider", "SecurityKeyProvider"]) {
		assert.throws(() => sshOptions({ [key]: "brew install x" }), /runs local programs/, key);
	}
	assert.throws(() => sshOptions({ "User=x -oProxyCommand": "y" }), /Not an ssh option name/);
});

test("a key and a port belong to the connection, a pty and stdin to the session", () => {
	assert.deepEqual(connectionFlags({ identity: "~/.ssh/id_ed25519", port: 2222, agentForward: true }), ["-i", "~/.ssh/id_ed25519", "-p", "2222", "-A"]);
	assert.deepEqual(connectionFlags({}), []);
	assert.deepEqual(sessionFlags({ tty: true }), ["-t"]);
	assert.deepEqual(sessionFlags({ noStdin: true }), ["-n"]);
	// A pty and "never read stdin" contradict each other; the pty is what sudo needs.
	assert.deepEqual(sessionFlags({ tty: true, noStdin: true }), ["-t"]);
});

test("the remote command runs its script unchanged under bash, from the given directory", () => {
	const script = "printf '%s|' \"a'b\\\\c\" \"$(pwd)\"";
	assert.equal(bash(remoteCommand(script, "/")), "a'b\\c|/|");
	assert.equal(remoteCommand("true").includes("'"), false);
});
