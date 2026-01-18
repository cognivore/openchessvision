"""
Chessnut Move service client.

Pure-function client for syncing FEN positions to the Chessnut Move server.
Uses only stdlib (urllib, json) for minimal dependencies.

Environment variables:
  CHESSNUT_SERVICE_URL      Base URL (default: http://localhost:8675)
  CHESSNUT_SERVICE_TIMEOUT  Request timeout in seconds (default: 5)
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_URL = "http://localhost:8675"
DEFAULT_TIMEOUT = 5


@dataclass(frozen=True)
class ChessnutServiceConfig:
    """Configuration for the Chessnut Move service."""

    base_url: str
    timeout: float


@dataclass(frozen=True)
class ChessnutSyncResult:
    """Result of a FEN sync operation."""

    synced: bool
    error: str | None = None
    fen: str | None = None
    driver_synced: bool | None = None


def get_config(env: dict[str, str] | None = None) -> ChessnutServiceConfig:
    """
    Load configuration from environment variables.

    Args:
        env: Environment dict (defaults to os.environ)

    Returns:
        ChessnutServiceConfig with base_url and timeout
    """
    env = env if env is not None else os.environ
    base_url = env.get("CHESSNUT_SERVICE_URL", DEFAULT_URL).rstrip("/")
    timeout = float(env.get("CHESSNUT_SERVICE_TIMEOUT", str(DEFAULT_TIMEOUT)))
    return ChessnutServiceConfig(base_url=base_url, timeout=timeout)


def _post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """
    POST JSON to a URL and return the parsed response.

    Raises:
        URLError: Network or connection error
        HTTPError: HTTP error response
        json.JSONDecodeError: Invalid JSON response
    """
    data = json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def sync_fen(
    fen: str,
    config: ChessnutServiceConfig | None = None,
    force: bool = True,
) -> ChessnutSyncResult:
    """
    Sync a FEN position to the Chessnut Move service.

    Args:
        fen: FEN string (board-only or full)
        config: Service configuration (loads from env if None)
        force: Whether to force immediate board movement

    Returns:
        ChessnutSyncResult indicating success or failure
    """
    if config is None:
        config = get_config()

    url = f"{config.base_url}/api/state/fen"
    payload = {"fen": fen, "force": force}

    try:
        response = _post_json(url, payload, config.timeout)

        # The Chessnut server returns UpdateResponse with driver_synced
        return ChessnutSyncResult(
            synced=True,
            error=None,
            fen=response.get("fen"),
            driver_synced=response.get("driver_synced"),
        )

    except HTTPError as e:
        # Try to extract error message from response body
        try:
            body = json.loads(e.read().decode("utf-8"))
            detail = body.get("detail", str(e))
        except Exception:
            detail = str(e)
        return ChessnutSyncResult(synced=False, error=f"HTTP {e.code}: {detail}")

    except URLError as e:
        return ChessnutSyncResult(synced=False, error=f"Connection error: {e.reason}")

    except json.JSONDecodeError as e:
        return ChessnutSyncResult(synced=False, error=f"Invalid response: {e}")

    except TimeoutError:
        return ChessnutSyncResult(synced=False, error="Request timeout")

    except Exception as e:
        return ChessnutSyncResult(synced=False, error=str(e))
