"""Tests for the mock board driver."""

import pytest
from openchessvision.board.mock import MockBoardDriver, MockBoardConfig
from openchessvision.core.models import ConnectionStatus, SetPositionResultStatus


class TestMockBoardDriver:
    """Tests for MockBoardDriver."""

    @pytest.mark.asyncio
    async def test_scan_returns_device(self, mock_board: MockBoardDriver):
        """Scan should return a mock device."""
        devices = await mock_board.scan_for_devices(timeout_seconds=1.0)

        assert len(devices) == 1
        assert devices[0].model == "Mock Chessnut Move"

    @pytest.mark.asyncio
    async def test_connect_success(self, mock_board: MockBoardDriver):
        """Connect should succeed by default."""
        status = await mock_board.connect()

        assert status == ConnectionStatus.CONNECTED
        assert mock_board.connection_status == ConnectionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_connect_failure(self):
        """Connect should fail when configured to."""
        config = MockBoardConfig(fail_connect=True, connect_delay_ms=10)
        board = MockBoardDriver(config)

        status = await board.connect()

        assert status == ConnectionStatus.ERROR

    @pytest.mark.asyncio
    async def test_disconnect(self, mock_board: MockBoardDriver):
        """Disconnect should reset state."""
        await mock_board.connect()
        await mock_board.disconnect()

        assert mock_board.connection_status == ConnectionStatus.DISCONNECTED

    @pytest.mark.asyncio
    async def test_set_position_requires_connection(self, mock_board: MockBoardDriver):
        """set_position should fail when not connected."""
        result = await mock_board.set_position("4k3/8/8/8/8/8/8/4K3 w - - 0 1")

        assert result.status == SetPositionResultStatus.FAILED
        assert "Not connected" in result.message

    @pytest.mark.asyncio
    async def test_set_position_validates_fen(self, mock_board: MockBoardDriver):
        """set_position should validate FEN before sending."""
        await mock_board.connect()

        # Invalid FEN (no kings)
        result = await mock_board.set_position("8/8/8/8/8/8/8/8 w - - 0 1")

        assert result.status == SetPositionResultStatus.FAILED
        assert "Invalid FEN" in result.message

    @pytest.mark.asyncio
    async def test_set_position_success(
        self,
        mock_board: MockBoardDriver,
        empty_board_fen: str,
    ):
        """set_position should succeed with valid FEN."""
        await mock_board.connect()

        result = await mock_board.set_position(empty_board_fen)

        assert result.status == SetPositionResultStatus.SUCCESS

        # Check position was updated
        position = await mock_board.get_position()
        assert position is not None
        assert "e1" in position  # White king
        assert "e8" in position  # Black king

    @pytest.mark.asyncio
    async def test_command_logging(self, mock_board: MockBoardDriver):
        """Commands should be logged for testing."""
        await mock_board.scan_for_devices()
        await mock_board.connect()

        log = mock_board.command_log

        assert len(log) >= 2
        assert log[0].command == "scan"
        assert "connect" in [entry.command for entry in log]

    @pytest.mark.asyncio
    async def test_stop_motion(self, mock_board: MockBoardDriver):
        """stop_motion should be logged."""
        await mock_board.connect()
        await mock_board.stop_motion()

        log = mock_board.command_log
        assert any(entry.command == "stop_motion" for entry in log)

    @pytest.mark.asyncio
    async def test_set_leds(self, mock_board: MockBoardDriver):
        """set_leds should update lit squares."""
        await mock_board.connect()
        await mock_board.set_leds(["e4", "d5"], color="green")

        lit = mock_board.get_lit_squares()
        assert "e4" in lit
        assert "d5" in lit
