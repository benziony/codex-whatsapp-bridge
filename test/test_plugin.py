import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


PLUGIN = (
    Path(__file__).resolve().parents[1]
    / "hermes-plugin"
    / "codex_whatsapp_bridge"
    / "plugin.py"
)
SPEC = importlib.util.spec_from_file_location("codex_whatsapp_plugin_test", PLUGIN)
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)


def event(*, chat="123-456@g.us", sender="15551234567@s.whatsapp.net", message="m1", quoted=None):
    return SimpleNamespace(
        source=SimpleNamespace(chat_id=chat, user_id=sender),
        message_id=message,
        reply_to_message_id=quoted,
        message_type=SimpleNamespace(value="text"),
        text="hello",
        media_urls=[],
        media_types=[],
        raw_message={},
        metadata={},
    )


def config():
    return {
        "schemaVersion": 1,
        "gateway": {},
        "whatsapp": {
            "chatId": "123-456@g.us",
            "allowedSenders": ["15551234567@s.whatsapp.net"],
        },
    }


class PluginTests(unittest.IsolatedAsyncioTestCase):
    def test_narrow_sender_and_chat_boundary(self):
        self.assertEqual(
            plugin._authorized(event(), config()),
            ("15551234567@s.whatsapp.net", "123-456@g.us", "m1"),
        )
        self.assertIsNone(plugin._authorized(event(sender="16661234567@s.whatsapp.net"), config()))
        self.assertIsNone(plugin._authorized(event(chat="999-999@g.us"), config()))

    async def test_unknown_quote_is_not_retried_as_new_task(self):
        calls = []
        original_config = plugin._read_config
        original_attachments = plugin._attachments
        original_broker = plugin._broker
        try:
            plugin._read_config = config
            plugin._attachments = lambda _event: []

            async def broker(command, payload, _config):
                calls.append((command, payload))
                return {"status": "stale", "acknowledgement": "Unknown quote"}

            plugin._broker = broker
            result = await plugin._admit(event(quoted="unknown"))
        finally:
            plugin._read_config = original_config
            plugin._attachments = original_attachments
            plugin._broker = original_broker
        self.assertEqual(result, "Unknown quote")
        self.assertEqual([call[0] for call in calls], ["ingest"])

    async def test_unquoted_message_uses_new_task_admission(self):
        calls = []
        original_config = plugin._read_config
        original_attachments = plugin._attachments
        original_broker = plugin._broker
        try:
            plugin._read_config = config
            plugin._attachments = lambda _event: []

            async def broker(command, payload, _config):
                calls.append((command, payload))
                return {"status": "queued"}

            plugin._broker = broker
            result = await plugin._admit(event())
        finally:
            plugin._read_config = original_config
            plugin._attachments = original_attachments
            plugin._broker = original_broker
        self.assertIs(result, True)
        self.assertEqual([call[0] for call in calls], ["ingest-new-task"])

    async def test_text_document_uses_original_caption_not_hermes_injection(self):
        captured = []
        original_config = plugin._read_config
        original_attachments = plugin._attachments
        original_broker = plugin._broker
        try:
            plugin._read_config = config
            plugin._attachments = lambda _event: [{"path": "/tmp/document.txt"}]

            async def broker(command, payload, _config):
                captured.append((command, payload))
                return {"status": "queued"}

            plugin._broker = broker
            document = event()
            document.text = "[Content of document.txt]:\n" + ("x" * 20_000)
            document.metadata = {"whatsapp_original_body": "Please inspect this"}
            result = await plugin._admit(document)
        finally:
            plugin._read_config = original_config
            plugin._attachments = original_attachments
            plugin._broker = original_broker
        self.assertIs(result, True)
        self.assertEqual(captured[0][1]["text"], "Please inspect this")

    async def test_voice_transcription_is_prefixed(self):
        captured = []
        original_config = plugin._read_config
        original_transcribe = plugin._transcribe
        original_broker = plugin._broker
        try:
            plugin._read_config = config

            async def transcribe(_event):
                return "hello from voice"

            async def broker(command, payload, _config):
                captured.append((command, payload))
                return {"status": "queued"}

            plugin._transcribe = transcribe
            plugin._broker = broker
            voice = event()
            voice.message_type = SimpleNamespace(value="voice")
            result = await plugin._admit(voice)
        finally:
            plugin._read_config = original_config
            plugin._transcribe = original_transcribe
            plugin._broker = original_broker
        self.assertIs(result, True)
        self.assertEqual(captured[0][1]["text"], "Voice note transcription (may contain errors):\nhello from voice")


if __name__ == "__main__":
    unittest.main()
