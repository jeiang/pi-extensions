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
        nativeBuildInputs = [pkgs.git pkgs.bun];
        preBuild = "export HOME=$TMPDIR";
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev
          mkdir -p $out
          cp -r extensions package.json $out/
          if [ -d node_modules ]; then cp -r node_modules $out/; fi
          # pi-lens skips files its project .gitignore covers, so it never analyzed the session's
          # .worktrees/<name> checkout (workspace extension); treat such files as their own project.
          substituteInPlace $out/node_modules/pi-lens/dist/index.js \
            --replace-fail 'const targetIgnored = isPathIgnoredByProject(' 'const targetIgnored = !filePath.includes("/.worktrees/") && isPathIgnoredByProject(' \
            --replace-fail 'if (isPathIgnoredByProject(filePath, deps._ownerRoot ?? workspaceRoot, false)) {' 'if (!filePath.includes("/.worktrees/") && isPathIgnoredByProject(filePath, deps._ownerRoot ?? workspaceRoot, false)) {'
          runHook postInstall
        '';
      };
    });

    checks = forAllSystems (pkgs: {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {packages = [pkgs.nodejs_24 pkgs.bun];};
    });
  };
}
