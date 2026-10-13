{
  description = "High-performance multimodal Telegram gateway and remote control plane for DeepSeek Harness (DSH)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      rec {
        packages.dsh-telegram = pkgs.writeShellApplication {
          name = "dsh-telegram";
          runtimeInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
          ];
          text = ''
            exec ${pkgs.nodejs_22}/bin/node "${self}/dist/index.js" "$@"
          '';
        };

        packages.default = packages.dsh-telegram;

        apps.default = {
          type = "app";
          program = "${packages.default}/bin/dsh-telegram";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.typescript
          ];
        };
      }
    )
    // {
      overlays.default = final: prev: {
        dsh-telegram = self.packages.${prev.stdenv.system}.default;
      };
    };
}
