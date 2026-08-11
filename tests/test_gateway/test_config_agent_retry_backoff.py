from __future__ import annotations

import pytest
from pydantic import ValidationError

from opensquilla.gateway.config import GatewayConfig


def test_retry_backoff_defaults_to_none() -> None:
    """Unset backoff fields defer to the AgentConfig defaults at runtime."""
    config = GatewayConfig()

    assert config.agent_retry_base_backoff_ms is None
    assert config.agent_retry_max_backoff_ms is None


def test_retry_backoff_accepts_flat_interval() -> None:
    """base == cap produces a fixed 30s interval (the supported flat case)."""
    config = GatewayConfig(
        agent_retry_base_backoff_ms=30_000,
        agent_retry_max_backoff_ms=30_000,
    )

    assert config.agent_retry_base_backoff_ms == 30_000
    assert config.agent_retry_max_backoff_ms == 30_000


def test_retry_backoff_accepts_zero() -> None:
    """Zero disables the sleep between retries (test-only fast mode)."""
    config = GatewayConfig(
        agent_retry_base_backoff_ms=0,
        agent_retry_max_backoff_ms=0,
    )

    assert config.agent_retry_base_backoff_ms == 0
    assert config.agent_retry_max_backoff_ms == 0


@pytest.mark.parametrize("field", ["agent_retry_base_backoff_ms", "agent_retry_max_backoff_ms"])
def test_retry_backoff_rejects_negative(field: str) -> None:
    """Negative backoff would raise inside ``backoff_sleep`` mid-retry and
    abort an otherwise recoverable turn; reject it at config load instead."""
    with pytest.raises(ValidationError):
        GatewayConfig(**{field: -1})


def test_task_completion_guard_budgets_default_to_none() -> None:
    """Unset guard budgets defer to the AgentConfig defaults at runtime."""
    config = GatewayConfig()

    assert config.task_completion_guard_max_nudges is None
    assert config.task_completion_guard_max_unmarked_stops is None


def test_task_completion_guard_budgets_accept_long_task_values() -> None:
    """The long-writing-task profile: 64 nudges, 6 unmarked stops."""
    config = GatewayConfig(
        task_completion_guard_max_nudges=64,
        task_completion_guard_max_unmarked_stops=6,
    )

    assert config.task_completion_guard_max_nudges == 64
    assert config.task_completion_guard_max_unmarked_stops == 6


@pytest.mark.parametrize(
    "field",
    ["task_completion_guard_max_nudges", "task_completion_guard_max_unmarked_stops"],
)
def test_task_completion_guard_budgets_reject_negative(field: str) -> None:
    with pytest.raises(ValidationError):
        GatewayConfig(**{field: -1})
