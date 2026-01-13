"""
Mock board driver for testing and development.

Simulates a Chessnut Move e-board without requiring actual hardware.
Useful for:
- Testing the application without hardware
- Development and debugging
- Automated testing
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Sequence

from openchessvision.core.models import (
    ConnectionStatus,
    ConnectionQuality,
    DeviceInfo,
    SetPositionResult,
    SetPositionResultStatus,
)
from openchessvision.core.fen import validate_fen, fen_to_piece_map, STARTING_FEN


logger = logging.getLogger(__name__)


@dataclass
class MockBoardConfig:
    """Configuration for mock board behavior."""
    # Simulated delays
    scan_delay_ms: int = 500
    connect_delay_ms: int = 1000
    set_position_delay_ms: int = 2000

    # Simulated failures
    fail_connect: bool = False
    fail_set_position: bool = False
    fail_probability: float = 0.0  # Random failure probability

    # Device info
    device_name: str = "Mock Chessnut Move"
    firmware_version: str = "1.0.0-mock"
    serial_number: str = "MOCK-001"


@dataclass
class CommandLogEntry:
    """Log entry for a command sent to the mock board."""
    timestamp: datetime
    command: str
    args: dict
    result: str


class MockBoardDriver:
    """
    Mock implementation of the BoardDriver protocol.

    Simulates board behavior for testing and development.
    All commands are logged for verification in tests.
    """

    def __init__(self, config: MockBoardConfig | None = None) -> None:
        self._config = config or MockBoardConfig()
        self._status = ConnectionStatus.DISCONNECTED
        self._current_position: dict[str, str] = {}
        self._command_log: list[CommandLogEntry] = []
        self._lit_squares: set[str] = set()
        self._motion_in_progress = False

    @property
    def connection_status(self) -> ConnectionStatus:
        return self._status

    @property
    def command_log(self) -> list[CommandLogEntry]:
        """Access command log for testing."""
        return self._command_log.copy()

    @property
    def current_position(self) -> dict[str, str]:
        """Get the current simulated board position."""
        return self._current_position.copy()

    def _log_command(self, command: str, args: dict, result: str) -> None:
        """Log a command for testing verification."""
        entry = CommandLogEntry(
            timestamp=datetime.now(),
            command=command,
            args=args,
            result=result,
        )
        self._command_log.append(entry)
        logger.debug(f"MockBoard: {command} {args} -> {result}")

    async def scan_for_devices(
        self,
        timeout_seconds: float = 10.0
    ) -> Sequence[DeviceInfo]:
        """Simulate scanning for devices."""
        self._log_command("scan", {"timeout": timeout_seconds}, "started")

        await asyncio.sleep(self._config.scan_delay_ms / 1000)

        # Return a single mock device
        device = DeviceInfo(
            model=self._config.device_name,
            firmware_version=self._config.firmware_version,
            serial_number=self._config.serial_number,
            bluetooth_address="00:00:00:00:00:01",
        )

        self._log_command("scan", {"timeout": timeout_seconds}, "found 1 device")
        return [device]

    async def connect(
        self,
        device: DeviceInfo | None = None
    ) -> ConnectionStatus:
        """Simulate connecting to a device."""
        self._log_command("connect", {"device": device}, "started")
        self._status = ConnectionStatus.CONNECTING

        await asyncio.sleep(self._config.connect_delay_ms / 1000)

        if self._config.fail_connect:
            self._status = ConnectionStatus.ERROR
            self._log_command("connect", {"device": device}, "failed")
            return self._status

        self._status = ConnectionStatus.CONNECTED
        # Initialize with starting position
        self._current_position = fen_to_piece_map(STARTING_FEN)

        self._log_command("connect", {"device": device}, "connected")
        return self._status

    async def disconnect(self) -> None:
        """Simulate disconnecting from the device."""
        self._log_command("disconnect", {}, "started")

        self._status = ConnectionStatus.DISCONNECTED
        self._current_position = {}
        self._lit_squares = set()
        self._motion_in_progress = False

        self._log_command("disconnect", {}, "done")

    async def get_device_info(self) -> DeviceInfo | None:
        """Get info about the connected device."""
        if self._status != ConnectionStatus.CONNECTED:
            return None

        return DeviceInfo(
            model=self._config.device_name,
            firmware_version=self._config.firmware_version,
            serial_number=self._config.serial_number,
            bluetooth_address="00:00:00:00:00:01",
        )

    async def get_connection_quality(self) -> ConnectionQuality:
        """Get simulated connection quality metrics."""
        if self._status != ConnectionStatus.CONNECTED:
            return ConnectionQuality(rssi=None, last_seen_ms=0, error_rate=0.0)

        return ConnectionQuality(
            rssi=-50,  # Good signal
            last_seen_ms=10,
            error_rate=0.0,
        )

    async def set_position(self, fen: str) -> SetPositionResult:
        """
        Simulate setting up a position on the board.

        Validates the FEN and simulates the robotic movement.
        """
        self._log_command("set_position", {"fen": fen}, "started")

        if self._status != ConnectionStatus.CONNECTED:
            result = SetPositionResult(
                status=SetPositionResultStatus.FAILED,
                message="Not connected",
            )
            self._log_command("set_position", {"fen": fen}, "failed: not connected")
            return result

        # Validate FEN
        valid, error = validate_fen(fen, strict=False)
        if not valid:
            result = SetPositionResult(
                status=SetPositionResultStatus.FAILED,
                message=f"Invalid FEN: {error}",
            )
            self._log_command("set_position", {"fen": fen}, f"failed: {error}")
            return result

        # Simulate motion
        self._motion_in_progress = True

        try:
            if self._config.fail_set_position:
                await asyncio.sleep(self._config.set_position_delay_ms / 2000)
                self._motion_in_progress = False
                result = SetPositionResult(
                    status=SetPositionResultStatus.FAILED,
                    message="Simulated failure",
                )
                self._log_command("set_position", {"fen": fen}, "failed: simulated")
                return result

            await asyncio.sleep(self._config.set_position_delay_ms / 1000)

            # Update position
            self._current_position = fen_to_piece_map(fen)
            self._motion_in_progress = False

            result = SetPositionResult(
                status=SetPositionResultStatus.SUCCESS,
                message="Position set successfully",
                estimated_time_ms=self._config.set_position_delay_ms,
            )
            self._log_command("set_position", {"fen": fen}, "success")
            return result

        except asyncio.CancelledError:
            self._motion_in_progress = False
            result = SetPositionResult(
                status=SetPositionResultStatus.CANCELLED,
                message="Operation cancelled",
            )
            self._log_command("set_position", {"fen": fen}, "cancelled")
            return result

    async def get_position(self) -> dict[str, str] | None:
        """Get the current board position."""
        if self._status != ConnectionStatus.CONNECTED:
            return None

        return self._current_position.copy()

    async def stop_motion(self) -> None:
        """Emergency stop - halt all simulated motion."""
        self._log_command("stop_motion", {}, "executed")
        self._motion_in_progress = False

    async def set_leds(
        self,
        squares: Sequence[str],
        color: str = "green"
    ) -> None:
        """Simulate setting LED indicators on squares."""
        self._log_command("set_leds", {"squares": list(squares), "color": color}, "done")
        self._lit_squares = set(squares)

    # Test helper methods

    def reset_for_testing(self) -> None:
        """Reset the mock board state for a new test."""
        self._status = ConnectionStatus.DISCONNECTED
        self._current_position = {}
        self._command_log = []
        self._lit_squares = set()
        self._motion_in_progress = False

    def get_lit_squares(self) -> set[str]:
        """Get the currently lit squares (for testing)."""
        return self._lit_squares.copy()

    def is_motion_in_progress(self) -> bool:
        """Check if simulated motion is in progress."""
        return self._motion_in_progress
