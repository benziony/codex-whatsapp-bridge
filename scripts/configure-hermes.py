#!/usr/bin/env python3
"""Atomically install the reviewed exclusive inbound claim in Hermes YAML."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import yaml


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--allowed-sender", action="append", default=[])
    args = parser.parse_args()
    target = Path(args.config).expanduser()
    data = yaml.safe_load(target.read_text(encoding="utf-8")) if target.exists() else {}
    if not isinstance(data, dict):
        raise SystemExit("Hermes config must be a mapping")
    gateway = data.setdefault("gateway", {})
    platforms = gateway.setdefault("platforms", {})
    whatsapp = platforms.setdefault("whatsapp", {})
    extra = whatsapp.setdefault("extra", {})
    policy = str(extra.get("group_policy") or "pairing").strip().lower()
    if policy not in {"open", "allowlist"}:
        extra["group_policy"] = "allowlist"
    groups = extra.get("group_allow_from") or []
    if isinstance(groups, str):
        groups = [item.strip() for item in groups.split(",") if item.strip()]
    if not isinstance(groups, list):
        raise SystemExit("Hermes whatsapp group_allow_from must be a list or comma-separated text")
    extra["group_allow_from"] = list(dict.fromkeys([*map(str, groups), args.chat_id]))
    free = extra.get("free_response_chats") or []
    if isinstance(free, str):
        free = [item.strip() for item in free.split(",") if item.strip()]
    if not isinstance(free, list):
        raise SystemExit("Hermes whatsapp free_response_chats must be a list or comma-separated text")
    extra["free_response_chats"] = list(dict.fromkeys([*map(str, free), args.chat_id]))
    extra["exclusive_inbound"] = {
        "chat_id": args.chat_id,
        "handler": "codex_whatsapp_bridge",
        "allowed_senders": args.allowed_sender,
        "failure_message": (
            "This message could not be accepted by Codex WhatsApp Bridge. "
            "Please try again or open Codex."
        ),
    }
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        yaml.safe_dump(data, handle, sort_keys=False, allow_unicode=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    os.chmod(target, 0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
