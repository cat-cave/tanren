{
  description = "tanren dev environment (Node/pnpm monorepo)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_24
          just
          git
          lefthook
          # tanren's dev stack (postgres etc.) runs via compose -> rootless podman,
          # not from this shell; these are the host-side tools the repo scripts call.
        ];
        shellHook = ''
          # Per-project pnpm version (package.json: pnpm@11.1.0) via corepack, into a
          # project-local writable dir since the nix node store path is read-only.
          export COREPACK_HOME="$PWD/.corepack"
          mkdir -p "$COREPACK_HOME/bin"
          corepack enable --install-directory "$COREPACK_HOME/bin" pnpm 2>/dev/null || true
          export PATH="$COREPACK_HOME/bin:$PATH"
          echo "tanren devshell — node $(node -v); pnpm@11.1.0 via corepack"
        '';
      };
    };
}
