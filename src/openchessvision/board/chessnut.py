"""
Chessnut Move BLE driver.

Implements the BoardDriver protocol for the Chessnut Move robotic e-board
using Bluetooth Low Energy via the Bleak library.

Note: The Chessnut Move protocol is not fully documented. This implementation
is based on:
- Chessnut's public marketing materials
- Reverse engineering from similar products
- Community findings

The driver is designed to be updated as more protocol details become available.
"""

import asyncio
import logging
from typing import Sequence
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.characteristic import BleakGATTCharacteristic

from openchessvision.core.models import (
    ConnectionStatus,
    ConnectionQuality,
    DeviceInfo,
    SetPositionResult,
    SetPositionResultStatus,
)
from openchessvision.core.fen import validate_fen, fen_to_piece_map


logger = logging.getLogger(__name__)


# Chessnut Move BLE identifiers (may need adjustment based on actual device)
# These are placeholders based on common Chessnut product patterns
CHESSNUT_DEVICE_NAME_PREFIXES = ("Chessnut", "CN Move", "ChessnutMove")

# BLE Service and Characteristic UUIDs
# These need to be discovered from the actual device
CHESSNUT_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"  # Placeholder
CHESSNUT_WRITE_CHAR_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"  # Placeholder
CHESSNUT_NOTIFY_CHAR_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"  # Placeholder

# Protocol commands (placeholders - need reverse engineering)
CMD_GET_INFO = bytes([0x01])
CMD_SET_POSITION = bytes([0x02])
CMD_GET_POSITION = bytes([0x03])
CMD_STOP = bytes([0x04])
CMD_SET_LEDS = bytes([0x05])


@dataclass
class ChessnutDeviceInfo:
    """Extended device info with BLE-specific details."""
    device: BLEDevice
    rssi: int | None
    name: str


class ChessnutMoveDriver:
    """
    BLE driver for Chessnut Move robotic e-board.

    Handles:
    - Device discovery and connection
    - Position setup commands
    - Position reading
    - LED control
    - Emergency stop

    The protocol implementation is tentative and may need updates
    based on actual device behavior.
    """

    def __init__(
        self,
        auto_reconnect: bool = True,
        reconnect_delay_seconds: float = 5.0,
    ) -> None:
        self._auto_reconnect = auto_reconnect
        self._reconnect_delay = reconnect_delay_seconds

        self._status = ConnectionStatus.DISCONNECTED
        self._client: BleakClient | None = None
        self._device: BLEDevice | None = None
        self._device_info: DeviceInfo | None = None

        self._notification_queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._last_rssi: int | None = None
        self._last_seen_ms: int = 0
        self._error_count: int = 0
        self._command_count: int = 0

        self._reconnect_task: asyncio.Task | None = None
        self._stop_requested = False

    @property
    def connection_status(self) -> ConnectionStatus:
        return self._status

    async def scan_for_devices(
        self,
        timeout_seconds: float = 10.0
    ) -> Sequence[DeviceInfo]:
        """
        Scan for Chessnut Move devices.

        Returns a list of discovered devices matching Chessnut patterns.
        """
        logger.info(f"Scanning for Chessnut devices ({timeout_seconds}s timeout)...")
        self._status = ConnectionStatus.SCANNING

        devices: list[DeviceInfo] = []

        try:
            discovered = await BleakScanner.discover(timeout=timeout_seconds)

            for device in discovered:
                if self._is_chessnut_device(device):
                    info = DeviceInfo(
                        model="Chessnut Move",
                        firmware_version=None,
                        serial_number=None,
                        bluetooth_address=device.address,
                    )
                    devices.append(info)
                    logger.info(f"Found Chessnut device: {device.name} ({device.address})")

            if not devices:
                logger.warning("No Chessnut devices found")

        except Exception as e:
            logger.error(f"Scan error: {e}")
            self._status = ConnectionStatus.ERROR
            raise

        self._status = ConnectionStatus.DISCONNECTED
        return devices

    def _is_chessnut_device(self, device: BLEDevice) -> bool:
        """Check if a BLE device is a Chessnut product."""
        if device.name is None:
            return False

        name_lower = device.name.lower()
        return any(
            prefix.lower() in name_lower
            for prefix in CHESSNUT_DEVICE_NAME_PREFIXES
        )

    async def connect(
        self,
        device: DeviceInfo | None = None
    ) -> ConnectionStatus:
        """
        Connect to a Chessnut Move device.

        If device is None, scans and connects to the first found device.
        """
        # Disconnect any existing connection
        if self._client is not None:
            await self.disconnect()

        self._status = ConnectionStatus.CONNECTING
        self._stop_requested = False

        try:
            # Find device if not specified
            if device is None:
                devices = await self.scan_for_devices(timeout_seconds=5.0)
                if not devices:
                    self._status = ConnectionStatus.ERROR
                    return self._status
                device = devices[0]

            # Find the BLE device by address
            ble_device = await BleakScanner.find_device_by_address(
                device.bluetooth_address,
                timeout=10.0,
            )

            if ble_device is None:
                logger.error(f"Device not found: {device.bluetooth_address}")
                self._status = ConnectionStatus.ERROR
                return self._status

            self._device = ble_device

            # Create client and connect
            self._client = BleakClient(
                ble_device,
                disconnected_callback=self._on_disconnect,
            )

            await self._client.connect()

            if not self._client.is_connected:
                self._status = ConnectionStatus.ERROR
                return self._status

            # Set up notifications
            await self._setup_notifications()

            # Get device info
            self._device_info = await self._read_device_info()

            self._status = ConnectionStatus.CONNECTED
            logger.info(f"Connected to {ble_device.name}")

            return self._status

        except Exception as e:
            logger.error(f"Connection error: {e}")
            self._status = ConnectionStatus.ERROR
            return self._status

    def _on_disconnect(self, client: BleakClient) -> None:
        """Handle unexpected disconnection."""
        logger.warning("Device disconnected")
        self._status = ConnectionStatus.DISCONNECTED

        if self._auto_reconnect and not self._stop_requested:
            self._start_reconnect()

    def _start_reconnect(self) -> None:
        """Start the reconnection task."""
        if self._reconnect_task is not None:
            return

        async def reconnect_loop() -> None:
            while not self._stop_requested:
                await asyncio.sleep(self._reconnect_delay)

                try:
                    logger.info("Attempting reconnection...")
                    status = await self.connect(
                        DeviceInfo(
                            model="Chessnut Move",
                            bluetooth_address=self._device.address if self._device else None,
                        )
                    )

                    if status == ConnectionStatus.CONNECTED:
                        logger.info("Reconnection successful")
                        break

                except Exception as e:
                    logger.error(f"Reconnection failed: {e}")

            self._reconnect_task = None

        self._reconnect_task = asyncio.create_task(reconnect_loop())

    async def _setup_notifications(self) -> None:
        """Set up BLE notifications for device responses."""
        if self._client is None:
            return

        try:
            await self._client.start_notify(
                CHESSNUT_NOTIFY_CHAR_UUID,
                self._notification_handler,
            )
        except Exception as e:
            logger.warning(f"Could not set up notifications: {e}")

    def _notification_handler(
        self,
        characteristic: BleakGATTCharacteristic,
        data: bytes
    ) -> None:
        """Handle incoming BLE notifications."""
        logger.debug(f"Notification: {data.hex()}")
        self._notification_queue.put_nowait(data)
        self._last_seen_ms = 0  # Reset last seen timer

    async def _read_device_info(self) -> DeviceInfo:
        """Read device information from the board."""
        # This would send a command and parse the response
        # For now, return placeholder info
        return DeviceInfo(
            model="Chessnut Move",
            firmware_version=None,
            serial_number=None,
            bluetooth_address=self._device.address if self._device else None,
        )

    async def disconnect(self) -> None:
        """Disconnect from the device."""
        self._stop_requested = True

        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            self._reconnect_task = None

        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception as e:
                logger.warning(f"Disconnect error: {e}")
            finally:
                self._client = None

        self._status = ConnectionStatus.DISCONNECTED
        self._device = None
        self._device_info = None
        logger.info("Disconnected from Chessnut Move")

    async def get_device_info(self) -> DeviceInfo | None:
        """Get information about the connected device."""
        return self._device_info

    async def get_connection_quality(self) -> ConnectionQuality:
        """Get connection quality metrics."""
        error_rate = (
            self._error_count / self._command_count
            if self._command_count > 0 else 0.0
        )

        return ConnectionQuality(
            rssi=self._last_rssi,
            last_seen_ms=self._last_seen_ms,
            error_rate=error_rate,
        )

    async def set_position(self, fen: str) -> SetPositionResult:
        """
        Command the board to set up the given position.

        Sends the FEN to the board which will robotically move pieces.
        """
        if self._status != ConnectionStatus.CONNECTED or self._client is None:
            return SetPositionResult(
                status=SetPositionResultStatus.FAILED,
                message="Not connected",
            )

        # Validate FEN
        valid, error = validate_fen(fen, strict=False)
        if not valid:
            return SetPositionResult(
                status=SetPositionResultStatus.FAILED,
                message=f"Invalid FEN: {error}",
            )

        self._command_count += 1

        try:
            # Encode the position command
            # This is a placeholder - actual protocol needs reverse engineering
            command = self._encode_set_position(fen)

            await self._client.write_gatt_char(
                CHESSNUT_WRITE_CHAR_UUID,
                command,
            )

            # Wait for acknowledgment (with timeout)
            try:
                response = await asyncio.wait_for(
                    self._notification_queue.get(),
                    timeout=30.0,  # Position setup can take time
                )

                if self._parse_ack(response):
                    return SetPositionResult(
                        status=SetPositionResultStatus.SUCCESS,
                        message="Position set successfully",
                    )
                else:
                    self._error_count += 1
                    return SetPositionResult(
                        status=SetPositionResultStatus.FAILED,
                        message="Board rejected command",
                    )

            except asyncio.TimeoutError:
                self._error_count += 1
                return SetPositionResult(
                    status=SetPositionResultStatus.FAILED,
                    message="Timeout waiting for board response",
                )

        except Exception as e:
            logger.error(f"set_position error: {e}")
            self._error_count += 1
            return SetPositionResult(
                status=SetPositionResultStatus.FAILED,
                message=str(e),
            )

    def _encode_set_position(self, fen: str) -> bytes:
        """
        Encode a FEN string into the board's protocol format.

        This is a placeholder - the actual encoding needs to be
        discovered from the real device protocol.
        """
        # Placeholder: command byte + FEN as ASCII
        return CMD_SET_POSITION + fen.encode("ascii")

    def _parse_ack(self, response: bytes) -> bool:
        """Parse an acknowledgment response from the board."""
        # Placeholder - actual parsing depends on protocol
        if len(response) < 1:
            return False
        return response[0] == 0x00  # Assume 0x00 = success

    async def get_position(self) -> dict[str, str] | None:
        """
        Read the current physical position from the board.

        Uses the board's sensors to detect piece positions.
        """
        if self._status != ConnectionStatus.CONNECTED or self._client is None:
            return None

        try:
            await self._client.write_gatt_char(
                CHESSNUT_WRITE_CHAR_UUID,
                CMD_GET_POSITION,
            )

            response = await asyncio.wait_for(
                self._notification_queue.get(),
                timeout=5.0,
            )

            return self._parse_position(response)

        except Exception as e:
            logger.error(f"get_position error: {e}")
            return None

    def _parse_position(self, data: bytes) -> dict[str, str]:
        """
        Parse a position response from the board.

        Placeholder - actual format depends on protocol.
        """
        # This would decode the board's position format
        # For now, return empty
        return {}

    async def stop_motion(self) -> None:
        """
        Emergency stop - halt all robotic motion immediately.

        This is a high-priority command.
        """
        logger.warning("EMERGENCY STOP requested")

        if self._client is None:
            return

        try:
            # Send stop command with high priority
            await self._client.write_gatt_char(
                CHESSNUT_WRITE_CHAR_UUID,
                CMD_STOP,
                response=False,  # Don't wait for response
            )
        except Exception as e:
            logger.error(f"stop_motion error: {e}")

    async def set_leds(
        self,
        squares: Sequence[str],
        color: str = "green"
    ) -> None:
        """
        Set LED indicators on specific squares.

        Useful for highlighting suggested moves or errors.
        """
        if self._client is None:
            return

        try:
            command = self._encode_leds(squares, color)
            await self._client.write_gatt_char(
                CHESSNUT_WRITE_CHAR_UUID,
                command,
            )
        except Exception as e:
            logger.error(f"set_leds error: {e}")

    def _encode_leds(self, squares: Sequence[str], color: str) -> bytes:
        """Encode LED command."""
        # Placeholder encoding
        # Would encode square list and color into protocol format
        return CMD_SET_LEDS + bytes([len(squares)])
