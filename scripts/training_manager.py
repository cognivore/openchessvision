#!/usr/bin/env python3
"""
Chess CNN Training Manager for Vast.ai

A resilient local manager that:
- Creates and tracks its own Vast.ai H100 instance
- Uploads training data and code
- Runs CNN training
- Downloads trained model
- Destroys instance when done

Usage:
    python training_manager.py              # Start/resume training
    python training_manager.py status       # Check status
    python training_manager.py destroy      # Force destroy tracked instance
    python training_manager.py download     # Download results manually

State is persisted to .training-manager.state
"""

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error


# ─────────────────────────────────────────────────────────────────────────────
# State Management
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class TrainingManagerState:
    """Persistent state for the training manager."""

    instance_id: Optional[str] = None
    instance_host: Optional[str] = None
    instance_port: Optional[int] = None

    created_at: Optional[str] = None
    training_started_at: Optional[str] = None
    last_check_at: Optional[str] = None

    progress_history: list = field(default_factory=list)
    config_snapshot: dict = field(default_factory=dict)

    STATE_FILE = Path(__file__).parent / ".training-manager.state"

    def save(self):
        """Persist state to file."""
        with open(self.STATE_FILE, "w") as f:
            json.dump(asdict(self), f, indent=2)
        print(f"[State] Saved to {self.STATE_FILE}")

    @classmethod
    def load(cls) -> "TrainingManagerState":
        """Load state from file or create new."""
        if cls.STATE_FILE.exists():
            try:
                with open(cls.STATE_FILE) as f:
                    data = json.load(f)
                if "progress_history" not in data:
                    data["progress_history"] = []
                if "config_snapshot" not in data:
                    data["config_snapshot"] = {}
                return cls(**data)
            except (json.JSONDecodeError, TypeError) as e:
                print(f"[Warning] Failed to load state: {e}, starting fresh")
                return cls()
        return cls()

    def clear_instance(self):
        """Clear instance info (after destroy)."""
        self.instance_id = None
        self.instance_host = None
        self.instance_port = None
        self.created_at = None
        self.training_started_at = None
        self.progress_history = []
        self.save()


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Config:
    """Configuration for training manager."""

    # Vast.ai settings - use 1xH100
    gpu_type: str = "H100"
    num_gpus: int = 1
    max_price_per_hour: float = 3.50
    min_gpu_ram: int = 80
    min_disk: int = 50
    min_ram: int = 32

    # Training settings
    epochs: int = 50
    batch_size: int = 64
    learning_rate: float = 0.001

    # Paths
    remote_dir: str = "/root/chess-training"
    local_project_dir: str = str(Path(__file__).parent.parent)
    scripts_dir: str = str(Path(__file__).parent)
    data_dir: str = str(Path(__file__).parent.parent / "data")
    models_dir: str = str(Path(__file__).parent.parent / "models")

    # SSH
    ssh_key_path: str = str(Path.home() / ".ssh" / "id_ed25519")

    # Polling
    check_interval: int = 60  # seconds


# ─────────────────────────────────────────────────────────────────────────────
# Vast.ai Client
# ─────────────────────────────────────────────────────────────────────────────


class VastClient:
    """Client for Vast.ai API."""

    BASE_URL = "https://console.vast.ai/api/v0"

    def __init__(self):
        self.api_key = self._get_api_key()

    def _get_api_key(self) -> str:
        """Get API key from environment or passveil."""
        key = os.getenv("VAST_API_KEY", "")
        if key:
            return key

        # Try passveil
        try:
            result = subprocess.run(
                ["passveil", "show", "vast.ai/api"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        raise RuntimeError("VAST_API_KEY not found. Set env var or install passveil.")

    def _request(self, method: str, endpoint: str, data: Optional[dict] = None) -> dict:
        """Make API request."""
        url = f"{self.BASE_URL}/{endpoint}"
        if "?" in url:
            url += f"&api_key={self.api_key}"
        else:
            url += f"?api_key={self.api_key}"

        headers = {"Accept": "application/json"}

        if data is not None:
            headers["Content-Type"] = "application/json"
            req = urllib.request.Request(
                url, data=json.dumps(data).encode(), headers=headers, method=method
            )
        else:
            req = urllib.request.Request(url, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            error_body = e.read().decode() if e.fp else ""
            raise RuntimeError(f"API error {e.code}: {error_body}")

    def list_instances(self) -> list[dict]:
        """List all instances."""
        result = self._request("GET", "instances/")
        return result.get("instances", [])

    def get_instance(self, instance_id: str) -> dict:
        """Get instance details."""
        result = self._request("GET", f"instances/{instance_id}/")
        return result.get("instances", {})

    def search_offers(self, config: Config) -> list[dict]:
        """Search for GPU offers."""
        import urllib.parse

        gpu_map = {
            "H100": "H100 NVL",
            "H100_SXM": "H100 SXM",
            "A100": "A100 PCIE",
            "A100_SXM": "A100 SXM4",
            "RTX_4090": "RTX 4090",
        }

        query = {
            "verified": {"eq": True},
            "rentable": {"eq": True},
            "gpu_ram": {"gte": config.min_gpu_ram * 1024},
            "disk_space": {"gte": config.min_disk},
            "dph_total": {"lte": config.max_price_per_hour},
            "cuda_max_good": {"gte": 12.0},
            "num_gpus": {"eq": config.num_gpus},
        }

        if config.gpu_type in gpu_map:
            query["gpu_name"] = {"eq": gpu_map[config.gpu_type]}

        query_str = urllib.parse.quote(json.dumps(query, separators=(",", ":")))
        order_str = urllib.parse.quote('[["dph_total","asc"]]')

        result = self._request("GET", f"bundles/?q={query_str}&order={order_str}")
        return result.get("offers", [])

    def create_instance(self, offer_id: int, disk: int = 50) -> dict:
        """Create a new instance."""
        data = {
            "client_id": "me",
            "image": "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime",
            "disk": disk,
            "onstart": "touch ~/.no_auto_tmux",
        }
        return self._request("PUT", f"asks/{offer_id}/", data)

    def destroy_instance(self, instance_id: str) -> dict:
        """Destroy an instance."""
        return self._request("DELETE", f"instances/{instance_id}/")


# ─────────────────────────────────────────────────────────────────────────────
# SSH/Rsync Helpers
# ─────────────────────────────────────────────────────────────────────────────


def ssh_command(
    state: TrainingManagerState,
    config: Config,
    cmd: str,
    capture: bool = False,
    timeout: int = 60,
) -> subprocess.CompletedProcess:
    """Run SSH command on remote instance."""
    if not state.instance_host or not state.instance_port:
        raise RuntimeError("No instance configured")

    ssh_args = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        "-p", str(state.instance_port),
    ]

    if config.ssh_key_path and os.path.exists(config.ssh_key_path):
        ssh_args.extend(["-i", config.ssh_key_path])

    ssh_args.append(f"root@{state.instance_host}")
    ssh_args.append(cmd)

    if capture:
        return subprocess.run(ssh_args, capture_output=True, text=True, timeout=timeout)
    else:
        return subprocess.run(ssh_args, timeout=timeout)


def rsync_upload(
    state: TrainingManagerState, config: Config, local_path: str, remote_path: str,
    excludes: list[str] = None
) -> bool:
    """Upload files via rsync."""
    ssh_opts = f"-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p {state.instance_port}"
    if config.ssh_key_path and os.path.exists(config.ssh_key_path):
        ssh_opts += f" -i {config.ssh_key_path}"

    rsync_args = [
        "rsync", "-avz", "--progress",
        "-e", f"ssh {ssh_opts}",
    ]

    if excludes is None:
        excludes = [".venv", "__pycache__", "*.pyc", ".git", "runs"]

    for exclude in excludes:
        rsync_args.extend(["--exclude", exclude])

    rsync_args.extend([
        f"{local_path}/",
        f"root@{state.instance_host}:{remote_path}/",
    ])

    result = subprocess.run(rsync_args)
    return result.returncode == 0


def rsync_download(
    state: TrainingManagerState, config: Config, remote_path: str, local_path: str
) -> bool:
    """Download files via rsync."""
    ssh_opts = f"-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p {state.instance_port}"
    if config.ssh_key_path and os.path.exists(config.ssh_key_path):
        ssh_opts += f" -i {config.ssh_key_path}"

    rsync_args = [
        "rsync", "-avz", "--progress",
        "-e", f"ssh {ssh_opts}",
        f"root@{state.instance_host}:{remote_path}/",
        f"{local_path}/",
    ]

    result = subprocess.run(rsync_args)
    return result.returncode == 0


# ─────────────────────────────────────────────────────────────────────────────
# Progress Display
# ─────────────────────────────────────────────────────────────────────────────


def print_progress_chart(history: list[dict], total_epochs: int = 50):
    """Print ASCII progress chart."""
    if len(history) < 1:
        return

    width = 50

    print("\n" + "=" * 65)
    print("  CHESS CNN TRAINING PROGRESS")
    print("=" * 65)

    display_history = history[-15:]

    for h in display_history:
        epoch = h.get("epoch", 0)
        acc = h.get("accuracy", 0)
        pct = epoch / total_epochs
        bar_len = int(pct * width)
        bar = "\u2588" * bar_len + "\u2591" * (width - bar_len)
        time_str = h.get("time", "")[-8:]
        print(f"  {time_str} |{bar}| Epoch {epoch:>2}/{total_epochs} Acc: {acc:.1%}")

    if display_history:
        latest = display_history[-1]
        pct = latest.get("epoch", 0) / total_epochs * 100
        print("=" * 65)
        print(f"  Progress: {pct:.1f}% | Best Acc: {latest.get('accuracy', 0):.2%}")

    print("=" * 65 + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# Training Manager
# ─────────────────────────────────────────────────────────────────────────────


class TrainingManager:
    """Main training manager class."""

    def __init__(self):
        self.config = Config()
        self.state = TrainingManagerState.load()
        self.client = VastClient()

    def provision(self) -> bool:
        """Provision a new instance (or reconnect to existing)."""
        if self.state.instance_id:
            print(f"[Provision] Found existing instance: {self.state.instance_id}")
            try:
                instance = self.client.get_instance(self.state.instance_id)
                status = instance.get("actual_status", "unknown")
                if status == "running":
                    print(f"[Provision] Instance is running at {self.state.instance_host}:{self.state.instance_port}")
                    return True
                else:
                    print(f"[Provision] Instance status: {status}, will create new")
                    self.state.clear_instance()
            except Exception as e:
                print(f"[Provision] Existing instance not accessible: {e}")
                self.state.clear_instance()

        print(f"[Provision] Searching for {self.config.num_gpus}x {self.config.gpu_type} @ <${self.config.max_price_per_hour}/hr...")
        offers = self.client.search_offers(self.config)

        if not offers:
            print("[Provision] No offers found matching criteria")
            return False

        offer = offers[0]
        print(f"[Provision] Found: {offer.get('gpu_name')} @ ${offer.get('dph_total', 0):.3f}/hr")

        print("[Provision] Creating instance...")
        result = self.client.create_instance(offer["id"], disk=self.config.min_disk)

        if not result.get("success"):
            print(f"[Provision] Failed: {result}")
            return False

        instance_id = str(result.get("new_contract"))
        print(f"[Provision] Instance created: {instance_id}")

        print("[Provision] Waiting for instance to start...")
        for _ in range(60):
            time.sleep(5)
            instance = self.client.get_instance(instance_id)
            status = instance.get("actual_status", "unknown")
            print(f"[Provision]   Status: {status}")

            if status == "running":
                ssh_host = instance.get("ssh_host")
                ssh_port = instance.get("ssh_port", 22)

                self.state.instance_id = instance_id
                self.state.instance_host = ssh_host
                self.state.instance_port = ssh_port
                self.state.created_at = datetime.now().isoformat()
                self.state.save()

                print(f"[Provision] Instance running, waiting for SSH...")
                if self._wait_for_ssh():
                    print(f"[Provision] Ready: {ssh_host}:{ssh_port}")
                    return True
                else:
                    print("[Provision] SSH failed to become ready")
                    return False

        print("[Provision] Timeout waiting for instance")
        return False

    def _wait_for_ssh(self, max_retries: int = 12, delay: int = 5) -> bool:
        """Wait for SSH to be ready."""
        for attempt in range(max_retries):
            try:
                result = ssh_command(self.state, self.config, "echo SSH_READY", capture=True, timeout=15)
                if result.returncode == 0 and "SSH_READY" in result.stdout:
                    return True
            except subprocess.TimeoutExpired:
                pass
            except Exception as e:
                print(f"[Provision]   SSH attempt {attempt + 1}/{max_retries}: {e}")

            if attempt < max_retries - 1:
                print(f"[Provision]   SSH not ready, retrying in {delay}s...")
                time.sleep(delay)

        return False

    def setup(self) -> bool:
        """Upload code and data, setup environment."""
        print("[Setup] Creating remote directories...")
        ssh_command(self.state, self.config, f"mkdir -p {self.config.remote_dir}/data")
        ssh_command(self.state, self.config, f"mkdir -p {self.config.remote_dir}/models")

        # Upload scripts
        print("[Setup] Uploading training scripts...")
        if not rsync_upload(self.state, self.config, self.config.scripts_dir, f"{self.config.remote_dir}/scripts"):
            print("[Setup] Failed to upload scripts")
            return False

        # Upload training data
        print("[Setup] Uploading training data (tiles)...")
        if not rsync_upload(self.state, self.config, self.config.data_dir, f"{self.config.remote_dir}/data"):
            print("[Setup] Failed to upload data")
            return False

        # Install dependencies
        print("[Setup] Installing Python dependencies...")
        install_cmd = """
pip install --upgrade pip
pip install torch torchvision pillow numpy tqdm
"""
        result = ssh_command(self.state, self.config, install_cmd, timeout=300)
        if result.returncode != 0:
            print("[Setup] Failed to install dependencies")
            return False

        print("[Setup] Complete")
        return True

    def start_training(self) -> bool:
        """Start training in tmux session."""
        print(f"[Train] Starting CNN training ({self.config.epochs} epochs)...")

        # Kill existing session
        ssh_command(self.state, self.config, "tmux kill-session -t training 2>/dev/null || true")
        time.sleep(1)

        training_script = f"""#!/bin/bash
set -e
LOGFILE="{self.config.remote_dir}/training.log"
exec > >(tee -a "$LOGFILE") 2>&1
echo "=========================================="
echo "Chess CNN Training started at $(date)"
echo "Epochs: {self.config.epochs}"
echo "=========================================="
cd {self.config.remote_dir}
python -c "import torch; print(f'CUDA: {{torch.cuda.is_available()}}, Device: {{torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"CPU\"}}')"
python scripts/train_recognizer.py \\
    --input=data/tiles \\
    --output=models/chess_recognizer.pt \\
    --epochs={self.config.epochs} \\
    --batch-size={self.config.batch_size}
echo "=========================================="
echo "TRAINING_COMPLETE"
echo "Training finished at $(date)"
echo "=========================================="
"""

        script_cmd = f"cat > {self.config.remote_dir}/run_training.sh << 'EOF'\n{training_script}\nEOF"
        ssh_command(self.state, self.config, script_cmd)
        ssh_command(self.state, self.config, f"chmod +x {self.config.remote_dir}/run_training.sh")

        tmux_cmd = f"""
tmux new-session -d -s training -c {self.config.remote_dir}
tmux send-keys -t training 'bash {self.config.remote_dir}/run_training.sh' Enter
"""
        result = ssh_command(self.state, self.config, tmux_cmd)

        if result.returncode != 0:
            print("[Train] Failed to start tmux session")
            return False

        time.sleep(2)
        result = ssh_command(
            self.state, self.config,
            "tmux has-session -t training 2>/dev/null && echo RUNNING || echo STOPPED",
            capture=True,
        )

        if result.stdout.strip() != "RUNNING":
            print("[Train] Training session failed to start")
            return False

        self.state.training_started_at = datetime.now().isoformat()
        self.state.save()

        print("[Train] Training started in tmux session")
        return True

    def check_status(self) -> dict:
        """Check training status."""
        try:
            result = ssh_command(
                self.state, self.config,
                "tmux has-session -t training 2>/dev/null && echo RUNNING || echo STOPPED",
                capture=True, timeout=30,
            )
            is_running = "RUNNING" in result.stdout

            # Get epoch progress
            result = ssh_command(
                self.state, self.config,
                f'grep -oP "Epoch \\K\\d+" {self.config.remote_dir}/training.log 2>/dev/null | tail -1',
                capture=True, timeout=30,
            )
            epoch = 0
            try:
                epoch = int(result.stdout.strip())
            except ValueError:
                pass

            # Get accuracy
            result = ssh_command(
                self.state, self.config,
                f'grep -oP "Test Acc:\\s*\\K[0-9.]+" {self.config.remote_dir}/training.log 2>/dev/null | tail -1',
                capture=True, timeout=30,
            )
            accuracy = 0.0
            try:
                accuracy = float(result.stdout.strip())
            except ValueError:
                pass

            # Check completion
            is_complete = False
            if epoch >= self.config.epochs - 1:
                result = ssh_command(
                    self.state, self.config,
                    f"grep -c TRAINING_COMPLETE {self.config.remote_dir}/training.log 2>/dev/null || echo 0",
                    capture=True, timeout=30,
                )
                is_complete = result.stdout.strip() not in ("0", "")

            return {
                "running": is_running,
                "complete": is_complete,
                "epoch": epoch,
                "accuracy": accuracy,
                "time": datetime.now().isoformat(),
            }
        except Exception as e:
            print(f"[Status] Error checking status: {e}")
            return {
                "running": False,
                "complete": False,
                "epoch": 0,
                "accuracy": 0.0,
                "time": datetime.now().isoformat(),
            }

    def download_results(self) -> Optional[Path]:
        """Download trained model."""
        dest_dir = Path(self.config.models_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)

        print(f"[Download] Downloading model to {dest_dir}")

        # Download model file
        ssh_opts = f"-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p {self.state.instance_port}"
        if self.config.ssh_key_path and os.path.exists(self.config.ssh_key_path):
            ssh_opts += f" -i {self.config.ssh_key_path}"

        scp_args = [
            "scp",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-P", str(self.state.instance_port),
        ]
        if self.config.ssh_key_path and os.path.exists(self.config.ssh_key_path):
            scp_args.extend(["-i", self.config.ssh_key_path])

        scp_args.extend([
            f"root@{self.state.instance_host}:{self.config.remote_dir}/models/chess_recognizer.pt",
            str(dest_dir / "chess_recognizer.pt"),
        ])

        result = subprocess.run(scp_args)
        if result.returncode != 0:
            print("[Download] Failed to download model")
            return None

        # Also download log
        scp_args[-2] = f"root@{self.state.instance_host}:{self.config.remote_dir}/training.log"
        scp_args[-1] = str(dest_dir / "training.log")
        subprocess.run(scp_args, capture_output=True)

        print(f"[Download] Complete: {dest_dir}")
        return dest_dir

    def destroy_instance(self, force: bool = False) -> bool:
        """Destroy the instance."""
        if not self.state.instance_id:
            print("[Destroy] No tracked instance to destroy")
            return False

        instance_id = self.state.instance_id
        print(f"[Destroy] Destroying instance {instance_id}...")

        try:
            self.client.destroy_instance(instance_id)
            print(f"[Destroy] Instance {instance_id} destroyed")
        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                print(f"[Destroy] Instance {instance_id} already gone")
            else:
                print(f"[Destroy] API error: {e}")

        self.state.clear_instance()
        print("[Destroy] Local state cleared")
        return True

    def run(self):
        """Main run loop."""
        print("\n" + "=" * 65)
        print("  CHESS CNN TRAINING MANAGER")
        print("  Vast.ai H100 instance management")
        print("=" * 65 + "\n")

        if self.state.instance_id:
            print(f"[Resume] Found existing instance: {self.state.instance_id}")
            print(f"[Resume] Created: {self.state.created_at}")

            if not self.state.training_started_at:
                print("[Resume] Training not started, setting up...")
                if not self.setup():
                    print("[Error] Failed to setup environment")
                    return
                if not self.start_training():
                    print("[Error] Failed to start training")
                    return
        else:
            if not self.provision():
                print("[Error] Failed to provision instance")
                return

            if not self.setup():
                print("[Error] Failed to setup environment")
                return

            if not self.start_training():
                print("[Error] Failed to start training")
                return

        # Monitor loop
        print(f"\n[Monitor] Monitoring training (Ctrl+C to stop)...")
        print(f"[Monitor] Checking every {self.config.check_interval} seconds")

        try:
            while True:
                status = self.check_status()

                self.state.progress_history.append({
                    "time": status["time"],
                    "epoch": status["epoch"],
                    "accuracy": status["accuracy"],
                })
                self.state.last_check_at = status["time"]
                self.state.save()

                print_progress_chart(self.state.progress_history, self.config.epochs)

                if status["complete"]:
                    print("\n[Complete] Training finished!")
                    dest_dir = self.download_results()

                    if dest_dir:
                        print("[Complete] Destroying instance...")
                        self.destroy_instance()
                        print(f"\n[SUCCESS] Model saved to: {dest_dir}/chess_recognizer.pt")
                    else:
                        print("[Warning] Download failed, keeping instance")

                    return

                if not status["running"] and status["epoch"] > 1:
                    print("\n[Warning] Training stopped unexpectedly!")
                    print("[Warning] Download results and investigate")

                time.sleep(self.config.check_interval)

        except KeyboardInterrupt:
            print("\n\n[Stopped] Monitoring stopped")
            print(f"[Stopped] Instance still running: {self.state.instance_id}")
            print("[Stopped] Resume: python training_manager.py")
            print("[Stopped] Destroy: python training_manager.py destroy")


def main():
    parser = argparse.ArgumentParser(description="Chess CNN Training Manager")
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=["run", "status", "download", "destroy"],
    )
    parser.add_argument("--force", action="store_true")

    args = parser.parse_args()
    manager = TrainingManager()

    if args.command == "status":
        if manager.state.instance_id:
            print(f"Instance ID: {manager.state.instance_id}")
            print(f"Host: {manager.state.instance_host}:{manager.state.instance_port}")
            print(f"Created: {manager.state.created_at}")
            status = manager.check_status()
            print(f"Running: {status['running']}")
            print(f"Complete: {status['complete']}")
            print(f"Epoch: {status['epoch']}")
            print(f"Accuracy: {status['accuracy']:.2%}")
        else:
            print("No tracked instance")

    elif args.command == "download":
        if manager.state.instance_id:
            manager.download_results()
        else:
            print("No tracked instance")

    elif args.command == "destroy":
        manager.destroy_instance(force=args.force)

    else:
        manager.run()


if __name__ == "__main__":
    main()
