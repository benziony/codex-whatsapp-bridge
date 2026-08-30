#!/usr/bin/env python3
"""Isolated, bounded-output STT worker for Codex WhatsApp Bridge."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


_MAX_INPUT_BYTES = 16_384
_MAX_TRANSCRIPT_CHARS = 7_900


def _result(success: bool, transcript: str = "") -> None:
    sys.stdout.write(
        json.dumps(
            {"success": success, "transcript": transcript},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(_MAX_INPUT_BYTES + 1)
        if len(raw) > _MAX_INPUT_BYTES:
            _result(False)
            return 2
        payload = json.loads(raw.decode("utf-8"))
        path = payload.get("path") if isinstance(payload, dict) else None
        if not isinstance(path, str) or not Path(path).is_absolute():
            _result(False)
            return 2
        hermes_root = Path(os.environ.get("CODEX_WHATSAPP_HERMES_ROOT", ""))
        if not hermes_root.is_absolute() or not hermes_root.is_dir():
            _result(False)
            return 2
        sys.path.insert(0, str(hermes_root.resolve()))
        from tools.transcription_tools import (
            transcribe_audio,
            transcribe_audio_local_fallback,
        )

        result = transcribe_audio(path, None, "codex_whatsapp_bridge")
        if not isinstance(result, dict) or not result.get("success"):
            result = transcribe_audio_local_fallback(path)
        transcript = result.get("transcript") if isinstance(result, dict) else None
        if (
            not isinstance(transcript, str)
            or not transcript.strip()
            or len(transcript.strip()) > _MAX_TRANSCRIPT_CHARS
        ):
            _result(False)
            return 1
        _result(True, transcript.strip())
        return 0
    except Exception:
        _result(False)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

