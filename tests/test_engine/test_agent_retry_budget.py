from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from opensquilla.engine import Agent, AgentConfig, ThinkingLevel, ToolResult
from opensquilla.provider import ChatConfig, Message, ToolDefinition, ToolInputSchema
from opensquilla.provider import DoneEvent as ProviderDone
from opensquilla.provider import ErrorEvent as ProviderError
from opensquilla.provider import TextDeltaEvent as ProviderText
from opensquilla.provider import ToolUseEndEvent as ProviderToolUseEnd
from opensquilla.provider import ToolUseStartEvent as ProviderToolUseStart


class _SequenceProvider:
    provider_name = "fake"

    def __init__(self, streams: list[list[Any]]) -> None:
        self.streams = streams
        self.calls: list[dict[str, Any]] = []

    def chat(
        self,
        messages: list[Message],
        tools: list[Any] | None = None,
        config: ChatConfig | None = None,
    ) -> AsyncIterator[Any]:
        index = len(self.calls)
        self.calls.append({"messages": messages, "tools": tools})
        events = self.streams[index] if index < len(self.streams) else self.streams[-1]
        return self._stream(events)

    async def _stream(self, events: list[Any]) -> AsyncIterator[Any]:
        for event in events:
            yield event

    async def list_models(self) -> list[Any]:
        return []


class _CompositeSequenceProvider(_SequenceProvider):
    provider_name = "ensemble"
    retry_failed_call_safe = False


def _reasoning_only_done() -> ProviderDone:
    return ProviderDone(
        stop_reason="stop",
        input_tokens=4,
        output_tokens=2,
        reasoning_tokens=2,
        reasoning_content="internal",
    )


def _empty_done() -> ProviderDone:
    return ProviderDone(stop_reason="stop", input_tokens=3, output_tokens=0)


def _ok_done() -> ProviderDone:
    return ProviderDone(stop_reason="stop", input_tokens=5, output_tokens=1)


@pytest.mark.asyncio
async def test_reasoning_only_retries_once_then_errors() -> None:
    provider = _SequenceProvider(
        [
            [_reasoning_only_done()],
            [_reasoning_only_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            thinking=ThinkingLevel.MEDIUM,
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(
        event.kind == "warning" and event.code == "provider_reasoning_only_retry"
        for event in events
    )
    assert any(event.kind == "error" and event.code == "empty_response" for event in events)


@pytest.mark.asyncio
async def test_reasoning_only_resolves_on_retry() -> None:
    provider = _SequenceProvider(
        [
            [_reasoning_only_done()],
            [ProviderText(text="ok"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            thinking=ThinkingLevel.MEDIUM,
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(event.kind == "done" and event.text == "ok" for event in events)


@pytest.mark.asyncio
async def test_malformed_empty_retries_once_then_errors() -> None:
    provider = _SequenceProvider(
        [
            [_empty_done()],
            [_empty_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(event.kind == "warning" and event.code == "provider_empty_retry" for event in events)
    assert any(event.kind == "error" and event.code == "empty_response" for event in events)


@pytest.mark.asyncio
async def test_malformed_empty_resolves_on_retry() -> None:
    provider = _SequenceProvider(
        [
            [_empty_done()],
            [ProviderText(text="ok"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(event.kind == "done" and event.text == "ok" for event in events)


@pytest.mark.asyncio
async def test_stream_incomplete_retries_once_then_errors() -> None:
    provider = _SequenceProvider([[], []])
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(event.kind == "warning" and event.code == "provider_empty_retry" for event in events)
    assert any(
        event.kind == "error" and event.code == "provider_stream_incomplete"
        for event in events
    )


@pytest.mark.asyncio
async def test_stream_incomplete_resolves_on_retry() -> None:
    provider = _SequenceProvider(
        [
            [],
            [ProviderText(text="ok"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(event.kind == "done" and event.text == "ok" for event in events)


@pytest.mark.asyncio
async def test_timeout_error_code_retries_when_message_lacks_timeout_token() -> None:
    provider = _SequenceProvider(
        [
            [ProviderError(message="Request timed out: ", code="timeout")],
            [ProviderText(text="ok"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 2
    assert any(event.kind == "done" and event.text == "ok" for event in events)
    assert not any(event.kind == "error" and event.code == "timeout" for event in events)


@pytest.mark.asyncio
async def test_composite_timeout_surfaces_without_replaying_full_call() -> None:
    provider = _CompositeSequenceProvider(
        [
            [ProviderError(message="Request timed out: ", code="timeout")],
            [ProviderText(text="should-not-run"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=3,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 1
    assert any(event.kind == "error" and event.code == "timeout" for event in events)
    assert not any(
        event.kind == "text_delta" and event.text == "should-not-run"
        for event in events
    )


@pytest.mark.asyncio
async def test_composite_partial_timeout_does_not_duplicate_visible_text() -> None:
    provider = _CompositeSequenceProvider(
        [
            [
                ProviderText(text="partial"),
                ProviderError(message="Request timed out: ", code="timeout"),
            ],
            [ProviderText(text="duplicate"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=3,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 1
    visible = [event.text for event in events if event.kind == "text_delta"]
    assert visible == ["partial"]
    assert any(event.kind == "error" and event.code == "timeout" for event in events)


@pytest.mark.asyncio
async def test_first_turn_provider_empty_response_error_surfaces_without_retry() -> None:
    provider = _SequenceProvider(
        [
            [ProviderError(message="Provider returned an empty response", code="empty_response")],
            [ProviderText(text="should-not-run"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 1
    assert any(event.kind == "error" and event.code == "empty_response" for event in events)


@pytest.mark.asyncio
async def test_post_tool_provider_empty_response_error_retries_once_and_recovers() -> None:
    provider = _SequenceProvider(
        [
            [
                ProviderToolUseStart(tool_use_id="tool-1", tool_name="echo"),
                ProviderToolUseEnd(
                    tool_use_id="tool-1",
                    tool_name="echo",
                    arguments={"value": "ok"},
                ),
                ProviderDone(stop_reason="tool_use", input_tokens=3, output_tokens=1),
            ],
            [ProviderError(message="Provider returned an empty response", code="empty_response")],
            [ProviderText(text="done"), _ok_done()],
        ]
    )

    async def tool_handler(call: object) -> ToolResult:
        return ToolResult(
            tool_use_id=getattr(call, "tool_use_id"),
            tool_name=getattr(call, "tool_name"),
            content="tool ok",
        )

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_iterations=2,
            max_provider_retries=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[
            ToolDefinition(
                name="echo",
                description="Echo.",
                input_schema=ToolInputSchema(
                    properties={"value": {"type": "string"}},
                    required=["value"],
                ),
            )
        ],
        tool_handler=tool_handler,
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 3
    assert any(event.kind == "warning" and event.code == "provider_empty_retry" for event in events)
    assert any(event.kind == "done" and event.text == "done" for event in events)


@pytest.mark.asyncio
async def test_post_tool_provider_empty_response_error_retries_once_with_default_budget() -> None:
    provider = _SequenceProvider(
        [
            [
                ProviderToolUseStart(tool_use_id="tool-1", tool_name="echo"),
                ProviderToolUseEnd(
                    tool_use_id="tool-1",
                    tool_name="echo",
                    arguments={"value": "ok"},
                ),
                ProviderDone(stop_reason="tool_use", input_tokens=3, output_tokens=1),
            ],
            [ProviderError(message="Provider returned an empty response", code="empty_response")],
            [ProviderError(message="Provider returned an empty response", code="empty_response")],
            [ProviderText(text="should-not-run"), _ok_done()],
        ]
    )

    async def tool_handler(call: object) -> ToolResult:
        return ToolResult(
            tool_use_id=getattr(call, "tool_use_id"),
            tool_name=getattr(call, "tool_name"),
            content="tool ok",
        )

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_iterations=2,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[
            ToolDefinition(
                name="echo",
                description="Echo.",
                input_schema=ToolInputSchema(
                    properties={"value": {"type": "string"}},
                    required=["value"],
                ),
            )
        ],
        tool_handler=tool_handler,
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 3
    assert (
        len(
            [
                event
                for event in events
                if event.kind == "warning" and event.code == "provider_empty_retry"
            ]
        )
        == 1
    )
    assert any(event.kind == "error" and event.code == "empty_response" for event in events)


@pytest.mark.asyncio
async def test_transport_error_retries_until_configured_budget() -> None:
    """ReadError-classified transport failures keep retrying within budget.

    The provider stream fails three times with a transport error
    (``Request error: ReadError('')`` -> transport_transient) and succeeds on
    the fourth call; a 15-retry budget covers all three failures.
    """
    transport_failure = [
        ProviderError(message="Request error: ReadError('')", code="request_error")
    ]
    provider = _SequenceProvider(
        [
            transport_failure,
            transport_failure,
            transport_failure,
            [ProviderText(text="recovered"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=15,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 4
    assert any(
        event.kind == "done" and event.text == "recovered" for event in events
    )
    assert not any(event.kind == "error" for event in events)
    # Each budgeted retry surfaces a user-visible progress warning carrying
    # the attempt number, the budget, and the sleep interval.
    retry_warnings = [
        event for event in events
        if event.kind == "warning" and event.code == "provider_retry"
    ]
    assert len(retry_warnings) == 3
    assert "retry 1/15 in 0s" in retry_warnings[0].message
    assert "retry 2/15 in 0s" in retry_warnings[1].message
    assert "retry 3/15 in 0s" in retry_warnings[2].message
    assert "transport_transient" in retry_warnings[0].message


@pytest.mark.asyncio
async def test_transport_error_surfaces_only_after_budget_exhausted() -> None:
    """The terminal error surfaces only after every configured retry is spent."""

    provider = _SequenceProvider(
        [[ProviderError(message="Request error: ReadError('')", code="request_error")]]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=2,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    events = [event async for event in agent.run_turn("hello")]

    # 1 initial attempt + 2 budgeted retries, then the error surfaces.
    assert len(provider.calls) == 3
    assert any(event.kind == "error" and event.code == "request_error" for event in events)
    retry_warnings = [
        event for event in events
        if event.kind == "warning" and event.code == "provider_retry"
    ]
    assert len(retry_warnings) == 2
    assert "retry 2/2" in retry_warnings[-1].message


@pytest.mark.asyncio
async def test_transport_retry_budget_is_independent_for_each_turn() -> None:
    """A recovered turn does not consume the next conversation turn's budget."""
    transport_failure = [
        ProviderError(message="Request error: ReadError('')", code="request_error")
    ]
    provider = _SequenceProvider(
        [
            transport_failure,
            [ProviderText(text="first recovered"), _ok_done()],
            transport_failure,
            [ProviderText(text="second recovered"), _ok_done()],
        ]
    )
    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_provider_retries=2,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
    )

    first_events = [event async for event in agent.run_turn("first")]
    second_events = [event async for event in agent.run_turn("second")]

    assert len(provider.calls) == 4
    assert any(event.kind == "done" and event.text == "first recovered" for event in first_events)
    assert any(event.kind == "done" and event.text == "second recovered" for event in second_events)
    first_retries = [
        event for event in first_events
        if event.kind == "warning" and event.code == "provider_retry"
    ]
    second_retries = [
        event for event in second_events
        if event.kind == "warning" and event.code == "provider_retry"
    ]
    assert len(first_retries) == 1
    assert len(second_retries) == 1
    assert "retry 1/2 in 0s" in first_retries[0].message
    assert "retry 1/2 in 0s" in second_retries[0].message


@pytest.mark.asyncio
async def test_transport_retry_budget_resets_after_successful_tool_call() -> None:
    """Each provider call after a successful tool boundary gets a fresh budget."""
    transport_failure = [
        ProviderError(message="Request error: ReadError('')", code="request_error")
    ]
    provider = _SequenceProvider(
        [
            transport_failure,
            [
                ProviderToolUseStart(tool_use_id="tool-1", tool_name="echo"),
                ProviderToolUseEnd(
                    tool_use_id="tool-1",
                    tool_name="echo",
                    arguments={"value": "ok"},
                ),
                ProviderDone(stop_reason="tool_use", input_tokens=3, output_tokens=1),
            ],
            transport_failure,
            transport_failure,
            [ProviderText(text="done"), _ok_done()],
        ]
    )

    async def tool_handler(call: object) -> ToolResult:
        return ToolResult(
            tool_use_id=getattr(call, "tool_use_id"),
            tool_name=getattr(call, "tool_name"),
            content="tool ok",
        )

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            max_iterations=2,
            max_provider_retries=2,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[
            ToolDefinition(
                name="echo",
                description="Echo.",
                input_schema=ToolInputSchema(
                    properties={"value": {"type": "string"}},
                    required=["value"],
                ),
            )
        ],
        tool_handler=tool_handler,
    )

    events = [event async for event in agent.run_turn("hello")]

    assert len(provider.calls) == 5
    assert any(event.kind == "done" and event.text == "done" for event in events)
    retry_warnings = [
        event for event in events
        if event.kind == "warning" and event.code == "provider_retry"
    ]
    assert len(retry_warnings) == 3
    assert "retry 1/2 in 0s" in retry_warnings[0].message
    assert "retry 1/2 in 0s" in retry_warnings[1].message
    assert "retry 2/2 in 0s" in retry_warnings[2].message
