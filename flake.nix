{
  description = "OpenChessVision - AI PDF Chess Book Reader with Chessnut Move Bluetooth Position Relay";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachSystem [ "aarch64-darwin" "x86_64-darwin" ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        lib = pkgs.lib;

        # Python with system-level packages that are hard to pip install
        pythonEnv = pkgs.python312.withPackages (ps: with ps; [
          # System packages (native deps are easier via nix)
          numpy
          opencv4
          pillow
          pytesseract

          # Development tools
          ipython
          pip
          virtualenv
        ]);
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Python environment
            pythonEnv

          # OCR engine
          tesseract

            # Qt6 for PyQt6 (qtwayland is Linux-only, not needed on macOS)
            qt6.qtbase

            # Build tools
            pkg-config

            # For BLE on macOS - no extra deps needed, uses CoreBluetooth

            # Development utilities
            git
            jq
          ];

          shellHook = ''
            # Ensure we're in the project directory
            export PROJECT_ROOT="$(pwd)"

            # Create venv if it doesn't exist
            if [ ! -d ".venv" ]; then
              echo "Creating Python virtual environment..."
              python -m venv .venv --system-site-packages
            fi

            # Activate venv
            source .venv/bin/activate

            # Install pip dependencies if requirements not met
            if [ -f "pyproject.toml" ]; then
              pip install -q -e ".[dev]" 2>/dev/null || true
            fi

            # Qt plugin path for PyQt6
            export QT_QPA_PLATFORM_PLUGIN_PATH="${pkgs.qt6.qtbase}/lib/qt-6/plugins/platforms"

            echo "OpenChessVision development environment ready!"
            echo "Python: $(python --version)"
          '';
        };

        devShell = self.devShells.${system}.default;
      }
    );
}
