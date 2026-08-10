from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from opensquilla.engine import Agent, AgentConfig, ToolResult
from opensquilla.engine.turn_runner.agent_bootstrap_stage import (
    _task_completion_guard_mode_from_env,
)
from opensquilla.engine.types import CompactionOutcome
from opensquilla.provider import DoneEvent as ProviderDone
from opensquilla.provider import Message
from opensquilla.provider import TextDeltaEvent as ProviderText
from opensquilla.provider import ToolDefinition, ToolInputSchema
from opensquilla.provider import ToolUseEndEvent as ProviderToolUseEnd
from opensquilla.provider import ToolUseStartEvent as ProviderToolUseStart


class _SequenceProvider:
    provider_name = "fake"

    def __init__(self, streams: list[list[Any]]) -> None:
        self.streams = streams
        self.calls: list[dict[str, Any]] = []

    def chat(self, messages, tools=None, config=None) -> AsyncIterator[Any]:  # noqa: ANN001
        index = len(self.calls)
        self.calls.append({"messages": messages, "tools": tools, "config": config})
        events = self.streams[index] if index < len(self.streams) else self.streams[-1]
        return self._stream(events)

    async def _stream(self, events: list[Any]) -> AsyncIterator[Any]:
        for event in events:
            yield event

    async def list_models(self) -> list[Any]:
        return []


def _text_stream(text: str) -> list[Any]:
    return [
        ProviderText(text=text),
        ProviderDone(stop_reason="stop", input_tokens=3, output_tokens=1),
    ]


def _tool_stream(tool_use_id: str = "tool-1") -> list[Any]:
    return [
        ProviderToolUseStart(tool_use_id=tool_use_id, tool_name="echo"),
        ProviderToolUseEnd(
            tool_use_id=tool_use_id,
            tool_name="echo",
            arguments={"value": "ok"},
        ),
        ProviderDone(stop_reason="tool_use", input_tokens=4, output_tokens=1),
    ]


async def _tool_handler(call: Any) -> ToolResult:
    return ToolResult(
        tool_use_id=call.tool_use_id,
        tool_name=call.tool_name,
        content="tool ok",
    )


def _echo_tool() -> ToolDefinition:
    return ToolDefinition(
        name="echo",
        description="Echo.",
        input_schema=ToolInputSchema(
            properties={"value": {"type": "string"}},
            required=["value"],
        ),
    )


def _guard_messages(call: dict[str, Any]) -> list[Any]:
    return [
        msg
        for msg in call["messages"]
        if msg.role == "user"
        and isinstance(msg.content, str)
        and msg.content.startswith("[Runtime check]")
    ]


@pytest.mark.asyncio
async def test_guard_off_ends_turn_on_text_only_stop() -> None:
    provider = _SequenceProvider([_text_stream("partial answer")])

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    events = [event async for event in agent.run_turn("write the volume")]

    assert any(event.kind == "done" for event in events)
    assert len(provider.calls) == 1
    assert not any(
        event.kind == "warning" and event.code == "task_completion_guard"
        for event in events
    )


@pytest.mark.asyncio
async def test_guard_nudges_then_accepts_tool_less_confirmation() -> None:
    provider = _SequenceProvider(
        [
            _text_stream("first half written"),
            _tool_stream("tool-1"),
            _text_stream("everything is written"),
            _text_stream("confirmed complete"),
        ]
    )

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            task_completion_guard_mode="warn_model",
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    events = [event async for event in agent.run_turn("write the volume")]

    assert any(event.kind == "done" for event in events)
    assert len(provider.calls) == 4
    guard_warnings = [
        event
        for event in events
        if event.kind == "warning" and event.code == "task_completion_guard"
    ]
    # One nudge after the first premature stop, another after the post-tool
    # stop; the tool-less reply to the second nudge is accepted as final.
    assert len(guard_warnings) == 2
    assert len(_guard_messages(provider.calls[1])) == 1
    assert len(_guard_messages(provider.calls[3])) == 2
    assert agent.config.metadata["task_completion_guard_nudges"] == 2


@pytest.mark.asyncio
async def test_guard_never_loops_on_repeated_text_only_replies() -> None:
    provider = _SequenceProvider(
        [
            _text_stream("done?"),
            _text_stream("still just text"),
        ]
    )

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            task_completion_guard_mode="warn_model",
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    events = [event async for event in agent.run_turn("write the volume")]

    assert any(event.kind == "done" for event in events)
    assert len(provider.calls) == 2
    assert agent.config.metadata["task_completion_guard_nudges"] == 1


@pytest.mark.asyncio
async def test_guard_respects_nudge_budget() -> None:
    provider = _SequenceProvider(
        [
            _text_stream("part one"),
            _tool_stream("tool-1"),
            _text_stream("part two"),
        ]
    )

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            task_completion_guard_mode="warn_model",
            task_completion_guard_max_nudges=1,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    events = [event async for event in agent.run_turn("write the volume")]

    assert any(event.kind == "done" for event in events)
    # The exhausted budget suppresses the second stop's nudge, so the turn
    # ends right after the post-tool text instead of nudging again.
    assert len(provider.calls) == 3
    assert agent.config.metadata["task_completion_guard_nudges"] == 1


@pytest.mark.asyncio
async def test_proactive_compaction_compacts_before_oversized_call() -> None:
    provider = _SequenceProvider([_text_stream("continued")])

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            proactive_compaction_enabled=True,
            context_window_tokens=200,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    compacted_messages = [Message(role="user", content="hello")]
    check_calls: list[int] = []

    async def _fake_check(messages, estimated_tokens, **kwargs):  # noqa: ANN001, ANN202
        check_calls.append(estimated_tokens)
        return CompactionOutcome(
            messages=compacted_messages,
            compacted=True,
            summary="older context summarized",
            removed_count=1,
        )

    agent._check_context_overflow = _fake_check  # type: ignore[method-assign]

    long_message = "x" * 4000
    events = [event async for event in agent.run_turn(long_message)]

    assert any(event.kind == "done" for event in events)
    # The gate fired once, then the rebuilt (compacted) request fit and the
    # provider was called exactly once.
    assert len(check_calls) == 2
    assert len(provider.calls) == 1
    assert agent.config.metadata["proactive_context_compactions"] == 1
    assert any(
        event.kind == "warning" and event.code == "context_proactive_compaction"
        for event in events
    )
    compaction_events = [event for event in events if event.kind == "compaction"]
    assert len(compaction_events) == 1
    assert compaction_events[0].summary == "older context summarized"
    # The provider only ever saw the compacted request, not the oversized one.
    # (The runtime context suffix may be spliced onto the compacted user
    # message, so match on content rather than exact equality.)
    seen_user_texts = [
        msg.content
        for msg in provider.calls[0]["messages"]
        if msg.role == "user" and isinstance(msg.content, str)
    ]
    assert any(text.startswith("hello") for text in seen_user_texts)
    assert not any(long_message in text for text in seen_user_texts)


@pytest.mark.asyncio
async def test_proactive_compaction_refusal_falls_through_to_provider() -> None:
    provider = _SequenceProvider([_text_stream("answered anyway")])

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            proactive_compaction_enabled=True,
            context_window_tokens=200,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    async def _fake_refusal(messages, estimated_tokens, **kwargs):  # noqa: ANN001, ANN202
        return None

    agent._check_context_overflow = _fake_refusal  # type: ignore[method-assign]

    events = [event async for event in agent.run_turn("x" * 4000)]

    # A refused compaction must not kill the turn: the original request goes
    # out and the reactive overflow path remains the backstop.
    assert any(event.kind == "done" for event in events)
    assert len(provider.calls) == 1
    assert "proactive_context_compactions" not in agent.config.metadata


@pytest.mark.asyncio
async def test_proactive_compaction_failure_falls_through_to_provider() -> None:
    provider = _SequenceProvider([_text_stream("answered anyway")])

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            proactive_compaction_enabled=True,
            context_window_tokens=200,
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
    )

    async def _fake_crash(messages, estimated_tokens, **kwargs):  # noqa: ANN001, ANN202
        raise RuntimeError("summarizer unavailable")

    agent._check_context_overflow = _fake_crash  # type: ignore[method-assign]

    events = [event async for event in agent.run_turn("x" * 4000)]

    # The proactive gate is speculative: a crashing compaction (summarizer
    # error, deadline) must never kill a turn the provider might still accept.
    assert any(event.kind == "done" for event in events)
    assert not any(event.kind == "error" for event in events)
    assert len(provider.calls) == 1
    assert "proactive_context_compactions" not in agent.config.metadata


@pytest.mark.asyncio
async def test_guard_skips_heartbeat_runs() -> None:
    provider = _SequenceProvider([_text_stream("HEARTBEAT OK")])

    agent = Agent(
        provider=provider,
        config=AgentConfig(
            task_completion_guard_mode="warn_model",
            retry_base_backoff_ms=0,
            retry_max_backoff_ms=0,
        ),
        tool_definitions=[_echo_tool()],
        tool_handler=_tool_handler,
        run_kind="heartbeat",
    )

    events = [event async for event in agent.run_turn("heartbeat poll")]

    assert any(event.kind == "done" for event in events)
    # A heartbeat's tool-less ack is the normal terminal shape: no nudge, no
    # extra provider call.
    assert len(provider.calls) == 1
    assert "task_completion_guard_nudges" not in agent.config.metadata


def test_guard_mode_env_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENSQUILLA_TASK_COMPLETION_GUARD", raising=False)
    assert _task_completion_guard_mode_from_env() == "off"
    assert _task_completion_guard_mode_from_env("warn_model") == "warn_model"

    monkeypatch.setenv("OPENSQUILLA_TASK_COMPLETION_GUARD", "warn_model")
    assert _task_completion_guard_mode_from_env() == "warn_model"

    monkeypatch.setenv("OPENSQUILLA_TASK_COMPLETION_GUARD", "bogus")
    with pytest.raises(ValueError, match="OPENSQUILLA_TASK_COMPLETION_GUARD"):
        _task_completion_guard_mode_from_env()
