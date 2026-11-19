#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EDITOR = ROOT / "lyz_editor.py"

HERO = {
    "heroID": 0,
    "heroName": "용윤",
    "heroFamilyName": "용",
    "hp": 100,
    "maxHP": 100,
    "baseAttri": [10, 10, 10, 10, 10, 10],
    "maxAttri": [10, 10, 10, 10, 10, 10],
    "baseFightSkill": [10, 10, 10, 10, 10, 10, 10, 10, 10],
    "maxFightSkill": [10, 10, 10, 10, 10, 10, 10, 10, 10],
    "baseLivingSkill": [10, 10, 10, 10, 10, 10, 10, 10, 10],
    "maxLivingSkill": [10, 10, 10, 10, 10, 10, 10, 10, 10],
    "kungfuSkills": [],
    "tagData": {"heroTagData": {}},
    "itemListData": {"money": 100, "items": [], "allItem": []},
    "equipSkills": {},
}

SAVE = {
    "worldTime": {"year": 1, "month": 1, "day": 1},
    "chapter": 1,
    "speEnhanceStone": 0,
}

INFO = {
    "SaveVersion": 1,
    "SaveTime": "2026-01-01T00:00:00.000Z",
    "SaveDetail": {"slot": "SaveSlot0"},
}

TEMP_HERO = []


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def write_slot(save_dir: Path, name: str = "SaveSlot0") -> Path:
    slot = save_dir / name
    slot.mkdir(parents=True, exist_ok=True)
    (slot / "Info").write_bytes(json_bytes(INFO))
    (slot / "Save").write_bytes(json_bytes(SAVE))
    (slot / "Hero").write_bytes(json_bytes([HERO, None]))
    (slot / "TempHero").write_bytes(json_bytes(TEMP_HERO))
    return slot


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class CliAndServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="lyz-tests-"))
        cls.save_dir = cls.temp_dir / "saves"
        cls.save_dir.mkdir(parents=True, exist_ok=True)
        write_slot(cls.save_dir, "SaveSlot0")

        cls.port = free_port()
        cls.proc = subprocess.Popen(
            [
                sys.executable,
                str(EDITOR),
                "serve",
                "--save-dir",
                str(cls.save_dir),
                "--port",
                str(cls.port),
                "--no-browser",
            ],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )

        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.wait_ready()

        html = cls.request("GET", "/")[1]
        m = re.search(r'<meta\s+name="lyz-api-token"\s+content="([^"]+)"', html)
        if not m:
            m = re.search(r"<meta\s+name='lyz-api-token'\s+content='([^']+)'", html)
        if not m:
            raise AssertionError("lyz-api-token meta tag was not found in /")
        cls.token = m.group(1)

    @classmethod
    def tearDownClass(cls) -> None:
        proc = getattr(cls, "proc", None)
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    stream.close()
        shutil.rmtree(getattr(cls, "temp_dir", None), ignore_errors=True)

    @classmethod
    def wait_ready(cls) -> None:
        deadline = time.time() + 15
        last_error: Exception | None = None
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                out, err = cls.proc.communicate(timeout=2)
                raise RuntimeError(
                    f"server exited early with {cls.proc.returncode}\nstdout:\n{out}\nstderr:\n{err}"
                )
            try:
                with urllib.request.urlopen(cls.base_url + "/", timeout=1) as resp:
                    if resp.status == 200:
                        resp.read()
                        return
            except Exception as exc:  # noqa: BLE001
                last_error = exc
            time.sleep(0.1)
        raise RuntimeError(f"server did not become ready: {last_error!r}")

    @classmethod
    def request(
        cls,
        method: str,
        path: str,
        *,
        token: str | None = None,
        origin: str | None = "http://127.0.0.1",
        host: str | None = None,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, str, dict[str, str]]:
        url = cls.base_url + path
        hdrs: dict[str, str] = {}
        if token is not None:
            hdrs["X-Lyz-Token"] = token
        if origin is not None:
            hdrs["Origin"] = origin
        if host is not None:
            hdrs["Host"] = host
        if headers:
            hdrs.update(headers)
        if body is not None:
            hdrs.setdefault("Content-Type", "application/json")

        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                text = resp.read().decode("utf-8", "replace")
                return resp.status, text, dict(resp.headers)
        except urllib.error.HTTPError as exc:
            with exc:
                text = exc.read().decode("utf-8", "replace")
                return exc.code, text, dict(exc.headers)

    def post_json(
        self,
        path: str,
        payload: Any,
        *,
        token: str | None = None,
        origin: str | None = "http://127.0.0.1",
        host: str | None = None,
    ) -> tuple[int, str, dict[str, str]]:
        return self.request(
            "POST",
            path,
            token=token,
            origin=origin,
            host=host,
            body=json_bytes(payload),
        )

    def test_get_root_without_token_contains_token_and_csp(self) -> None:
        status, body, headers = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn('name="lyz-api-token"', body)
        self.assertIn(self.token, body)
        self.assertIn("connect-src 'self'", body)

    def test_api_requires_token(self) -> None:
        status, _, _ = self.request("GET", "/api/slots")
        self.assertEqual(status, 403)

        status, _, _ = self.request("GET", "/api/slots", token="wrong-token")
        self.assertEqual(status, 403)

        status, _, _ = self.request("GET", "/api/slots", token=self.token)
        self.assertEqual(status, 200)

    def test_slot_read(self) -> None:
        status, body, _ = self.request(
            "GET",
            "/api/slot?name=SaveSlot0",
            token=self.token,
        )
        self.assertEqual(status, 200)
        parsed = json.loads(body)
        self.assertIn("files", parsed)
        self.assertIn("Hero", parsed["files"])
        self.assertIn("Save", parsed["files"])
        self.assertIn("Info", parsed["files"])
        self.assertIn("TempHero", parsed["files"])

    def test_bad_origin_rejected(self) -> None:
        status, _, _ = self.request(
            "GET",
            "/api/slots",
            token=self.token,
            origin="https://evil.example",
        )
        self.assertEqual(status, 403)

    def test_bad_host_rejected(self) -> None:
        status, _, _ = self.request(
            "GET",
            "/api/slots",
            token=self.token,
            host="evil.example",
        )
        self.assertEqual(status, 403)

    def test_save_with_preset_then_backup_and_restore(self) -> None:
        status, body, _ = self.post_json(
            "/api/save",
            {"name": "SaveSlot0", "preset": "starter_boost"},
            token=self.token,
        )
        self.assertEqual(status, 200, body)

        parsed = json.loads(body)
        self.assertIn("backups", parsed)
        self.assertGreaterEqual(len(parsed["backups"]), 1, parsed)

        backup_item = parsed["backups"][0]
        backup_name = backup_item if isinstance(backup_item, str) else backup_item.get("name")
        self.assertTrue(backup_name, parsed)

        status, body, _ = self.post_json(
            "/api/restore",
            {"name": "SaveSlot0", "backup": backup_name},
            token=self.token,
        )
        self.assertEqual(status, 200, body)

    def test_save_with_files_payload(self) -> None:
        files = {
            "Info": {"text": json.dumps(INFO, ensure_ascii=False), "isGzip": False, "hasBom": False},
            "Save": {"text": json.dumps({**SAVE, "chapter": 2}, ensure_ascii=False), "isGzip": False, "hasBom": False},
            "Hero": {"text": json.dumps([{**HERO, "heroName": "서버저장"}, None], ensure_ascii=False), "isGzip": False, "hasBom": False},
            "TempHero": {"text": "[]", "isGzip": False, "hasBom": False},
        }
        status, body, _ = self.post_json(
            "/api/save",
            {"name": "SaveSlot0", "files": files},
            token=self.token,
        )
        self.assertEqual(status, 200, body)

        parsed = json.loads(body)
        self.assertIn("backups", parsed)
        self.assertGreaterEqual(len(parsed["backups"]), 1)

        hero_path = self.save_dir / "SaveSlot0" / "Hero"
        saved = json.loads(hero_path.read_text(encoding="utf-8"))
        self.assertEqual(saved[0]["heroName"], "서버저장")
        self.assertTrue((self.save_dir / ".lyz_backups").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
