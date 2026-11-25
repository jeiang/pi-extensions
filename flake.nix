{
  description = "Extensions for the pi coding agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["aarch64-darwin" "x86_64-linux" "aarch64-linux"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: {
      default = pkgs.buildNpmPackage {
        pname = "pi-extensions";
        version = "0.1.0";
        src = ./.;
        nodejs = pkgs.nodejs_24;
        npmDeps = pkgs.importNpmLock {npmRoot = ./.;};
        inherit (pkgs.importNpmLock) npmConfigHook;
        npmBuildScript = "check";
        # The grep tests run pi's grep, which needs rg on PATH.
        nativeBuildInputs = [pkgs.git pkgs.bun pkgs.ripgrep];
        preBuild = "export HOME=$TMPDIR";
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev
          mkdir -p $out
          cp -r extensions prompts agents skills package.json $out/
          if [ -d node_modules ]; then cp -r node_modules $out/; fi
          # pi-lens skips files its project .gitignore covers, so it never analyzed the session's
          # .worktrees/<name> checkout (workspace extension); treat such files as their own project.
          substituteInPlace $out/node_modules/pi-lens/dist/index.js \
            --replace-fail 'const targetIgnored = isPathIgnoredByProject(' 'const targetIgnored = !filePath.includes("/.worktrees/") && isPathIgnoredByProject(' \
            --replace-fail 'if (isPathIgnoredByProject(filePath, deps._ownerRoot ?? workspaceRoot, false)) {' 'if (!filePath.includes("/.worktrees/") && isPathIgnoredByProject(filePath, deps._ownerRoot ?? workspaceRoot, false)) {'
          # pi-web-access reads any `data:` as an inline data URI, so Rust source like `data: &[u8]`
          # became an omission marker; a comma-less token that holds whitespace is code, not a URI.
          substituteInPlace $out/node_modules/pi-web-access/dist/index.js \
            --replace-fail 'if (missingComma && end === headerStart && candidate.enclosure === null) {' 'if (missingComma && (end === headerStart ? candidate.enclosure === null : /[ \t]/.test(text7.slice(headerStart, end)))) {'
          # Readability's _grabArticle dereferences topCandidate.parentNode, which is null for a candidate
          # the cleaning steps detached; the parse then threw instead of returning the article. Fall back to body.
          substituteInPlace $out/node_modules/@mozilla/readability/Readability.js \
            --replace-fail '        parentOfTopCandidate = topCandidate.parentNode;
        while (' '        parentOfTopCandidate = topCandidate.parentNode || doc.body;
        while (' \
            --replace-fail '      parentOfTopCandidate = topCandidate.parentNode;
      var siblings = parentOfTopCandidate.children;' '      parentOfTopCandidate = topCandidate.parentNode || doc.body;
      var siblings = parentOfTopCandidate.children;'
          # pi-lens spawns its linters with pi's PATH, which lacks the project devshell: cargo, go, and
          # dotnet look missing there. A command that is not on PATH is retried through pi-devshell-exec,
          # the wrapper pi-lsp already starts servers with, and the result replaces a failed probe.
          substituteInPlace $out/node_modules/pi-lens/dist/index.js \
            --replace-fail 'async function safeSpawnAsync(command, args, options) {' 'async function safeSpawnAsync(command, args, options) {
  if (safeSpawnAsync.wrapped?.has(command)) return viaDevshell(command, args, options);
  const direct = await spawnDirect(command, args, options);
  if (command === "pi-devshell-exec" || direct.status !== null || direct.error?.code !== "ENOENT") return direct;
  const wrapper = safeSpawnAsync.wrapper ??= (await spawnDirect("sh", ["-c", "command -v pi-devshell-exec"], { timeout: 5e3 })).status === 0;
  if (!wrapper) return direct;
  const viaWrapper = await viaDevshell(command, args, options);
  if (viaWrapper.status === 127 || /command not found/.test(viaWrapper.stderr ?? "")) return direct;
  (safeSpawnAsync.wrapped ??= new Set()).add(command);
  return viaWrapper;
}
async function viaDevshell(command, args, options) {
  return spawnDirect("pi-devshell-exec", [command, ...args], options);
}
async function spawnDirect(command, args, options) {'
          # A request budget can expire after the server closed its stream, as it does on shutdown; sending
          # $/cancelRequest then makes vscode-jsonrpc log "Connection is closed.", so skip the cancel once closing.
          substituteInPlace $out/node_modules/@ian-pascoe/pi-lsp/src/lsp-server-client.ts \
            --replace-fail '() => cancellation.cancel(),' '() => { if (!this.closing && !this.closed && this.terminalError === undefined) cancellation.cancel(); },'
          runHook postInstall
        '';
      };
    });

    checks = forAllSystems (pkgs: {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {packages = [pkgs.nodejs_24 pkgs.bun pkgs.ripgrep];};
    });
  };
}
