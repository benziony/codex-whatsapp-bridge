import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "configure-hermes.py"


class ConfigureHermesTests(unittest.TestCase):
    def run_configure(self, initial):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.yaml"
            target.write_text(yaml.safe_dump(initial), encoding="utf-8")
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--config",
                    str(target),
                    "--chat-id",
                    "123-456@g.us",
                    "--allowed-sender",
                    "15551234567@s.whatsapp.net",
                ],
                check=True,
            )
            return yaml.safe_load(target.read_text(encoding="utf-8"))

    def test_default_group_policy_becomes_exact_allowlist(self):
        result = self.run_configure({})
        extra = result["gateway"]["platforms"]["whatsapp"]["extra"]
        self.assertEqual(extra["group_policy"], "allowlist")
        self.assertEqual(extra["group_allow_from"], ["123-456@g.us"])
        self.assertEqual(extra["free_response_chats"], ["123-456@g.us"])
        self.assertEqual(
            extra["exclusive_inbound"]["allowed_senders"],
            ["15551234567@s.whatsapp.net"],
        )

    def test_existing_open_policy_and_group_lists_are_preserved(self):
        result = self.run_configure(
            {
                "gateway": {
                    "platforms": {
                        "whatsapp": {
                            "extra": {
                                "group_policy": "open",
                                "group_allow_from": ["older@g.us"],
                                "free_response_chats": ["older@g.us"],
                            }
                        }
                    }
                }
            }
        )
        extra = result["gateway"]["platforms"]["whatsapp"]["extra"]
        self.assertEqual(extra["group_policy"], "open")
        self.assertEqual(extra["group_allow_from"], ["older@g.us", "123-456@g.us"])
        self.assertEqual(extra["free_response_chats"], ["older@g.us", "123-456@g.us"])


if __name__ == "__main__":
    unittest.main()
