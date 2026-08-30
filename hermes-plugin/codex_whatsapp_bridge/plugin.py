"""External Hermes admission plugin for Codex WhatsApp Bridge."""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from pathlib import Path
from typing import Any


_USER_JID = re.compile(
    r"^(?P<id>[0-9]{1,32})(?::[0-9]{1,3})?@(?P<domain>s\.whatsapp\.net|c\.us|lid)$",
    re.IGNORECASE,
)
_CHAT_JID = re.compile(
    r"^(?P<id>[0-9]{1,32}(?:-[0-9]{1,32})?)(?::[0-9]{1,3})?@(?P<domain>s\.whatsapp\.net|c\.us|lid|g\.us)$",
    re.IGNORECASE,
)
_MESSAGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$")
_VOICE_PREFIX = "Voice note transcription (may contain errors):"
_MAX_ATTACHMENT_COUNT = 10
_MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
_MAX_AUDIO_BYTES = 25 * 1024 * 1024
_TRANSCRIBE_TIMEOUT = 90
_TRANSCRIBER = Path(__file__).with_name("voice_transcriber.py")


def _config_path() -> Path:
    configured = os.environ.get("CODEX_WHATSAPP_CONFIG")
    return (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".config" / "codex-whatsapp-bridge" / "config.json"
    )


def _read_config() -> dict[str, Any] | None:
    target = _config_path()
    try:
        if not target.is_file() or target.stat().st_size > 64 * 1024:
            return None
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        return None
    return value


def _normalize_jid(value: object, *, group: bool = False) -> str | None:
    match = (_CHAT_JID if group else _USER_JID).fullmatch(str(value or "").strip())
    if not match:
        return None
    identifier = match.group("id")
    domain = match.group("domain").lower()
    if "-" in identifier and domain != "g.us":
        return None
    return f"{identifier}@{'s.whatsapp.net' if domain == 'c.us' else domain}"


def _message_id(value: object) -> str | None:
    result = str(value or "").strip()
    return result if _MESSAGE_ID.fullmatch(result) else None


def _authorized(event: Any, config: dict[str, Any]) -> tuple[str, str, str] | None:
    whatsapp = config.get("whatsapp")
    if not isinstance(whatsapp, dict):
        return None
    chat_id = _normalize_jid(getattr(event.source, "chat_id", None), group=True)
    sender_id = _normalize_jid(getattr(event.source, "user_id", None))
    message_id = _message_id(getattr(event, "message_id", None))
    configured_chat = _normalize_jid(whatsapp.get("chatId"), group=True)
    raw_allowed = whatsapp.get("allowedSenders")
    if not isinstance(raw_allowed, list) or not raw_allowed:
        return None
    allowed = {_normalize_jid(value) for value in raw_allowed}
    if None in allowed or chat_id != configured_chat or sender_id not in allowed:
        return None
    return sender_id, chat_id, message_id if message_id else ""


def _media_roots() -> list[Path]:
    from gateway.platforms.base import (
        get_audio_cache_dir,
        get_document_cache_dir,
        get_image_cache_dir,
        get_video_cache_dir,
    )

    return [
        Path(value).resolve()
        for value in (
            get_image_cache_dir(),
            get_audio_cache_dir(),
            get_video_cache_dir(),
            get_document_cache_dir(),
        )
    ]


def _regular_file(value: str, roots: list[Path], maximum: int) -> Path | None:
    try:
        original = Path(value)
        if not original.is_absolute() or original.is_symlink():
            return None
        resolved = original.resolve()
        stat = resolved.stat()
    except (OSError, ValueError):
        return None
    if (
        not resolved.is_file()
        or stat.st_size <= 0
        or stat.st_size > maximum
        or not any(resolved != root and resolved.is_relative_to(root) for root in roots)
    ):
        return None
    return resolved


def _attachments(event: Any) -> list[dict[str, str]] | None:
    urls = list(getattr(event, "media_urls", None) or [])
    if not urls:
        return []
    if len(urls) > _MAX_ATTACHMENT_COUNT:
        return None
    types = list(getattr(event, "media_types", None) or [])
    raw = getattr(event, "raw_message", None)
    raw = raw if isinstance(raw, dict) else {}
    roots = _media_roots()
    result: list[dict[str, str]] = []
    total = 0
    for index, value in enumerate(urls):
        resolved = _regular_file(str(value), roots, _MAX_ATTACHMENT_BYTES)
        if resolved is None:
            return None
        total += resolved.stat().st_size
        if total > _MAX_ATTACHMENT_BYTES:
            return None
        mime = str(types[index] if index < len(types) else "application/octet-stream")
        name = (
            str(raw.get("fileName") or raw.get("filename"))
            if len(urls) == 1 and (raw.get("fileName") or raw.get("filename"))
            else resolved.name
        )
        kind = "image" if mime.lower().startswith("image/") else "file"
        result.append(
            {"path": str(resolved), "name": name[:512], "mime": mime[:192], "kind": kind}
        )
    return result


async def _transcribe(event: Any) -> str | None:
    urls = list(getattr(event, "media_urls", None) or [])
    if len(urls) != 1:
        return None
    path = _regular_file(str(urls[0]), _media_roots(), _MAX_AUDIO_BYTES)
    if path is None:
        return None
    process = None
    try:
        hermes_root = Path(__file__).resolve()
        while hermes_root != hermes_root.parent and not (hermes_root / "tools").is_dir():
            hermes_root = hermes_root.parent
        if not (hermes_root / "tools").is_dir():
            # External plugins live outside Hermes; import roots are already on
            # sys.path, so derive the checkout from the loaded gateway module.
            import gateway

            hermes_root = Path(gateway.__file__).resolve().parent.parent
        child_env = os.environ.copy()
        child_env["CODEX_WHATSAPP_HERMES_ROOT"] = str(hermes_root)
        child_env["PYTHONDONTWRITEBYTECODE"] = "1"
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(_TRANSCRIBER),
            cwd=str(hermes_root),
            env=child_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=os.name != "nt",
        )
        stdout, _ = await asyncio.wait_for(
            process.communicate(json.dumps({"path": str(path)}).encode()),
            timeout=_TRANSCRIBE_TIMEOUT,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL) if os.name != "nt" else process.kill()
            except (OSError, ProcessLookupError):
                pass
            await process.wait()
        if isinstance(error, asyncio.CancelledError):
            raise
        return None
    except (OSError, ValueError):
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        return None
    if process.returncode != 0 or len(stdout) > 16_384:
        return None
    try:
        result = json.loads(stdout.decode())
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    transcript = result.get("transcript") if isinstance(result, dict) else None
    return transcript.strip() if isinstance(transcript, str) and transcript.strip() else None


async def _broker(command: str, payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    gateway = config.get("gateway") if isinstance(config.get("gateway"), dict) else {}
    repository = gateway.get("repositoryPath")
    broker = gateway.get("brokerPath")
    if not broker and isinstance(repository, str):
        broker = str(Path(repository) / "scripts" / "codex-whatsapp-broker.mjs")
    node = gateway.get("node") or "/opt/homebrew/opt/node@24/bin/node"
    if not isinstance(broker, str) or not Path(broker).is_file() or not Path(node).is_file():
        raise RuntimeError("Codex WhatsApp broker is unavailable")
    async def invoke(next_command: str, next_payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        process = await asyncio.create_subprocess_exec(
            node,
            broker,
            next_command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=os.name != "nt",
        )
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(json.dumps(next_payload, separators=(",", ":")).encode()),
                timeout=timeout,
            )
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL) if os.name != "nt" else process.kill()
                except (OSError, ProcessLookupError):
                    pass
                await process.wait()
            raise
        if process.returncode != 0 or len(stdout) > 32_768:
            raise RuntimeError("Codex WhatsApp broker rejected the message")
        try:
            result = json.loads(stdout.decode())
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Codex WhatsApp broker returned invalid data") from error
        if not isinstance(result, dict):
            raise RuntimeError("Codex WhatsApp broker returned invalid data")
        return result

    try:
        return await invoke(command, payload, 120 if payload.get("attachments") else 15)
    except asyncio.TimeoutError as error:
        # The timed-out process is dead and reaped before we inspect durable
        # state. If it committed immediately before termination, return a
        # duplicate-success result so WhatsApp is never told a queued delivery
        # failed. If it did not commit, the visible failure is truthful.
        probe = {
            "chatId": payload.get("chatId"),
            "senderId": payload.get("senderId"),
            "messageId": payload.get("messageId"),
        }
        try:
            status = await invoke("admission-status", probe, 15)
        except asyncio.TimeoutError as probe_error:
            raise RuntimeError("Codex WhatsApp broker admission timed out") from probe_error
        if status.get("status") == "accepted":
            return {"ok": True, "status": "duplicate"}
        raise RuntimeError("Codex WhatsApp broker admission timed out") from error


async def _admit(event: Any) -> bool | str:
    config = _read_config()
    context = _authorized(event, config) if config else None
    if context is None or not context[2]:
        return "This WhatsApp sender or message identity is not allowed for Codex."
    sender_id, chat_id, message_id = context
    message_type = getattr(getattr(event, "message_type", None), "value", "")
    if message_type in {"voice", "audio"}:
        transcript = await _transcribe(event)
        if transcript is None:
            return "That voice note could not be transcribed. Please send text or retry in Codex."
        body = f"{_VOICE_PREFIX}\n{transcript}"
        attachments: list[dict[str, str]] = []
    else:
        metadata = getattr(event, "metadata", None)
        original_body = metadata.get("whatsapp_original_body") if isinstance(metadata, dict) else None
        body = str(original_body if isinstance(original_body, str) else (getattr(event, "text", "") or ""))
        attachments = _attachments(event)
        if attachments is None:
            return "That WhatsApp attachment could not be accepted. Please send it again or attach it in Codex."
    if not body.strip() and not attachments:
        return "That WhatsApp message did not contain text or a supported attachment."
    payload: dict[str, Any] = {
        "chatId": chat_id,
        "senderId": sender_id,
        "messageId": message_id,
        "text": body,
    }
    if attachments:
        payload["attachments"] = attachments
    quoted = _message_id(getattr(event, "reply_to_message_id", None))
    if getattr(event, "reply_to_message_id", None) is not None:
        payload["quotedMessageId"] = quoted or str(event.reply_to_message_id)
        result = await _broker("ingest", payload, config)
    else:
        result = await _broker("ingest-new-task", payload, config)
    if result.get("status") in {"queued", "duplicate"}:
        return True
    acknowledgement = result.get("acknowledgement")
    return (
        acknowledgement[:500]
        if isinstance(acknowledgement, str) and acknowledgement.strip()
        else "That WhatsApp message could not be queued for Codex."
    )


def register(ctx: Any) -> None:
    ctx.register_exclusive_inbound_handler("codex_whatsapp_bridge", _admit)
