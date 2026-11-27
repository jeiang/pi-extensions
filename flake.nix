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
        # The grep and find tests run pi's grep and find, which need rg and fd on PATH; the pty test
        # needs script(1), which macOS ships and Linux gets from util-linux.
        nativeBuildInputs = [pkgs.git pkgs.bun pkgs.ripgrep pkgs.fd] ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.util-linux;
        preBuild = "export HOME=$TMPDIR";
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev
          mkdir -p $out
          cp -r extensions prompts agents skills docs package.json $out/
          if [ -d node_modules ]; then cp -r node_modules $out/; fi
          # pi-web-access reads any `data:` as an inline data URI, so Rust source like `data: &[u8]`
          # became an omission marker; a comma-less token that holds whitespace is code, not a URI.
          substituteInPlace $out/node_modules/pi-web-access/dist/index.js \
            --replace-fail 'if (missingComma && end === headerStart && candidate.enclosure === null) {' 'if (missingComma && (end === headerStart ? candidate.enclosure === null : /[ \t]/.test(text7.slice(headerStart, end)))) {'
          # Readability's _grabArticle dereferences topCandidate.parentNode, which is null for a candidate
          # the cleaning steps detached; the parse then threw instead of returning the article. Fall back to body.
          substituteInPlace $out/node_modules/@mozilla/readability/Readability.js \
            --replace-fail $'        parentOfTopCandidate = topCandidate.parentNode;\n        while (' $'        parentOfTopCandidate = topCandidate.parentNode || doc.body;\n        while (' \
            --replace-fail $'      parentOfTopCandidate = topCandidate.parentNode;\n      var siblings = parentOfTopCandidate.children;' $'      parentOfTopCandidate = topCandidate.parentNode || doc.body;\n      var siblings = parentOfTopCandidate.children;'
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
