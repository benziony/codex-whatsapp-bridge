import asyncio
import importlib.util
import json
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


def event(*, chat="123-456@g.us", sender="15551234567@s.whatsapp.net", message="m1", quoted=None, metadata=None):
    return SimpleNamespace(
        source=SimpleNamespace(chat_id=chat, user_id=sender),
        message_id=message,
        reply_to_message_id=quoted,
        message_type=SimpleNamespace(value="text"),
        text="hello",
        media_urls=[],
        media_types=[],
        raw_message={},
        metadata=metadata or {},
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


def council_config():
    value = config()
    value["councilApprovals"] = {
        "chatId": "789-012@g.us",
        "allowedSenders": ["15551234567@s.whatsapp.net"],
        "councilUrl": "https://council.example",
        "codexCredentialFile": "/private/codex-council-token",
        "nativePolls": True,
    }
    return value


class PluginTests(unittest.IsolatedAsyncioTestCase):
    async def test_council_poll_vote_is_owner_chat_only_and_brokers_exact_poll(self):
        calls = []
        original_config = plugin._read_config
        original_broker = plugin._broker
        try:
            plugin._read_config = council_config

            async def broker(command, payload, _config):
                calls.append((command, payload))
                return {"status": "accepted", "acknowledgement": "Council approved."}

            plugin._broker = broker
            poll = event(chat="789-012@g.us", metadata={"whatsapp_native_type": "pollUpdateMessage", "whatsapp_native": {"pollUpdate": {"pollId": "WA.poll-1", "selectedOptions": ["Approve"]}}})
            result = await plugin._admit(poll)
            unrelated = await plugin._admit(event(chat="999-999@g.us", metadata={"whatsapp_native_type": "pollUpdateMessage", "whatsapp_native": {"pollUpdate": {"pollId": "WA.poll-2", "selectedOptions": ["Approve"]}}}))
        finally:
            plugin._read_config = original_config
            plugin._broker = original_broker
        self.assertEqual(result, "Council approved.")
        self.assertIs(unrelated, False)
        self.assertEqual(calls, [("council-poll-vote", {"pollMessageId": "WA.poll-1", "selectedOptions": ["Approve"], "chatId": "789-012@g.us", "senderId": "15551234567@s.whatsapp.net", "messageId": "m1"})])

    async def test_invalid_council_poll_vote_is_consumed_without_decision(self):
        original_config = plugin._read_config
        original_broker = plugin._broker
        try:
            plugin._read_config = council_config

            async def broker(*_args):
                raise AssertionError("invalid poll must not reach Council")

            plugin._broker = broker
            poll = event(chat="789-012@g.us", metadata={"whatsapp_native_type": "pollUpdateMessage", "whatsapp_native": {"pollUpdate": {"pollId": "WA.poll-1", "selectedOptions": ["Approve", "Reject"]}}})
            result = await plugin._admit(poll)
        finally:
            plugin._read_config = original_config
            plugin._broker = original_broker
        self.assertIn("could not be identified", result)

    async def test_uncertain_council_poll_outcome_is_not_reported_as_unrecorded(self):
        original_config = plugin._read_config
        original_broker = plugin._broker
        try:
            plugin._read_config = council_config

            async def broker(*_args):
                raise RuntimeError("Council poll decision outcome is uncertain")

            plugin._broker = broker
            poll = event(chat="789-012@g.us", metadata={"whatsapp_native_type": "pollUpdateMessage", "whatsapp_native": {"pollUpdate": {"pollId": "WA.poll-1", "selectedOptions": ["Approve"]}}})
            result = await plugin._admit(poll)
        finally:
            plugin._read_config = original_config
            plugin._broker = original_broker
        self.assertIn("could not be verified", result)
        self.assertIn("Check Council status", result)
        self.assertNotIn("No decision was recorded", result)

    async def test_council_timeout_uses_exact_readback_not_admission_status(self):
        calls = []
        original_spawn = plugin.asyncio.create_subprocess_exec
        original_killpg = plugin.os.killpg
        original_timeout = plugin._COUNCIL_APPROVAL_TIMEOUT
        original_recovery_timeout = plugin._COUNCIL_RECOVERY_TIMEOUT

        class Process:
            def __init__(self, command):
                self.command = command
                self.returncode = None
                self.pid = 1234

            async def communicate(self, _payload):
                if self.command == "council-approval":
                    await asyncio.sleep(1)
                self.returncode = 0
                return json.dumps({"ok": True, "status": "accepted", "acknowledgement": "Recovered from Council."}).encode(), b""

            async def wait(self):
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        async def spawn(*args, **_kwargs):
            calls.append(args[2])
            return Process(args[2])

        try:
            plugin.asyncio.create_subprocess_exec = spawn
            plugin.os.killpg = lambda *_args: None
            plugin._COUNCIL_APPROVAL_TIMEOUT = 0.01
            plugin._COUNCIL_RECOVERY_TIMEOUT = 0.1
            test_config = council_config()
            test_config["gateway"] = {"repositoryPath": str(PLUGIN.parents[2]), "node": sys.executable}
            result = await plugin._broker("council-approval", {"text": "APPROVE case REV 1 DIGEST " + ("a" * 64), "chatId": "789-012@g.us", "senderId": "15551234567@s.whatsapp.net", "messageId": "m1"}, test_config)
        finally:
            plugin.asyncio.create_subprocess_exec = original_spawn
            plugin.os.killpg = original_killpg
            plugin._COUNCIL_APPROVAL_TIMEOUT = original_timeout
            plugin._COUNCIL_RECOVERY_TIMEOUT = original_recovery_timeout
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(calls, ["council-approval", "council-approval-recover"])
        self.assertNotIn("admission-status", calls)

    async def test_poll_timeout_is_uncertain_without_admission_probe(self):
        calls = []
        original_spawn = plugin.asyncio.create_subprocess_exec
        original_killpg = plugin.os.killpg
        original_timeout = plugin._COUNCIL_POLL_TIMEOUT

        class Process:
            returncode = None
            pid = 1234
            async def communicate(self, _payload):
                await asyncio.sleep(1)
            async def wait(self):
                self.returncode = -9
                return self.returncode
            def kill(self):
                self.returncode = -9

        async def spawn(*args, **_kwargs):
            calls.append(args[2])
            return Process()

        try:
            plugin.asyncio.create_subprocess_exec = spawn
            plugin.os.killpg = lambda *_args: None
            plugin._COUNCIL_POLL_TIMEOUT = 0.01
            test_config = council_config()
            test_config["gateway"] = {"repositoryPath": str(PLUGIN.parents[2]), "node": sys.executable}
            with self.assertRaisesRegex(RuntimeError, "outcome is uncertain"):
                await plugin._broker("council-poll-vote", {"pollMessageId": "poll-1", "selectedOptions": ["Approve"], "chatId": "789-012@g.us", "senderId": "15551234567@s.whatsapp.net", "messageId": "m1"}, test_config)
        finally:
            plugin.asyncio.create_subprocess_exec = original_spawn
            plugin.os.killpg = original_killpg
            plugin._COUNCIL_POLL_TIMEOUT = original_timeout
        self.assertEqual(calls, ["council-poll-vote"])

    def test_narrow_sender_and_chat_boundary(self):
        self.assertEqual(
            plugin._authorized(event(), config()),
            ("15551234567@s.whatsapp.net", "123-456@g.us", "m1"),
        )
        self.assertIsNone(plugin._authorized(event(sender="16661234567@s.whatsapp.net"), config()))
        self.assertIsNone(plugin._authorized(event(chat="999-999@g.us"), config()))

    def test_council_sender_and_chat_boundary_is_separate(self):
        self.assertEqual(
            plugin._council_authorized(event(chat="789-012@g.us"), council_config()),
            ("15551234567@s.whatsapp.net", "789-012@g.us", "m1"),
        )
        self.assertIsNone(plugin._council_authorized(event(), council_config()))
        self.assertIsNone(plugin._council_authorized(event(chat="789-012@g.us", sender="16661234567@s.whatsapp.net"), council_config()))

    async def test_council_message_uses_verifying_broker_and_never_normal_task(self):
        calls = []
        original_config = plugin._read_config
        original_broker = plugin._broker
        try:
            plugin._read_config = council_config

            async def broker(command, payload, _config):
                calls.append((command, payload))
                return {"status": "accepted", "acknowledgement": "Council approved."}

            plugin._broker = broker
            result = await plugin._admit(event(chat="789-012@g.us"))
        finally:
            plugin._read_config = original_config
            plugin._broker = original_broker
        self.assertEqual(result, "Council approved.")
        self.assertEqual(calls, [("council-approval", {"text": "hello", "chatId": "789-012@g.us", "senderId": "15551234567@s.whatsapp.net", "messageId": "m1"})])

    async def test_council_voice_is_rejected_without_broker_call(self):
        original_config = plugin._read_config
        original_broker = plugin._broker
        try:
            plugin._read_config = council_config

            async def broker(*_args):
                raise AssertionError("voice must not reach Council broker")

            plugin._broker = broker
            voice = event(chat="789-012@g.us")
            voice.message_type = SimpleNamespace(value="voice")
            result = await plugin._admit(voice)
        finally:
            plugin._read_config = original_config
            plugin._broker = original_broker
        self.assertEqual(result, "Council approvals require exact text commands.")

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
