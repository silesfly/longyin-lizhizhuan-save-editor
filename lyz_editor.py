#!/usr/bin/env python3
"""용윤입지전(LongYinLiZhiZhuan) 세이브 슬롯 편집기: 표준 라이브러리 전용 CLI 및 로컬 서버."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import http.server
import json
import os
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any

KNOWN_FILES = ("Info", "Save", "Hero", "TempHero")
MAX_BACKUPS = 20
MAX_BODY = 64 * 1024 * 1024
DEFAULT_SAVE_DIR = Path.home() / "AppData" / "LocalLow" / "TppStudio" / "LongYinLiZhiZhuan" / "Save"
PRESETS = ("starter_boost", "attribute_peak", "martial_master", "world_harmony")


class LyzError(RuntimeError):
    """사용자에게 표시할 한국어 오류."""


def is_gzip_bytes(data: bytes) -> bool:
    return data[:2] == b"\x1f\x8b"


def read_slot_file(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    try:
        raw = p.read_bytes()
        compressed = is_gzip_bytes(raw)
        decompressed = gzip.decompress(raw) if compressed else raw
        has_bom = decompressed.startswith(b"\xef\xbb\xbf")
        text = decompressed.decode("utf-8-sig")
    except (OSError, EOFError, gzip.BadGzipFile, UnicodeError) as exc:
        raise LyzError(f"파일을 읽거나 해석할 수 없습니다: {p}") from exc
    return {
        "text": text,
        "isGzip": compressed,
        "hasBom": has_bom,
        "byteLength": len(raw),
    }


def _encode_slot_text(text: str, is_gzip: bool, has_bom: bool) -> bytes:
    payload = text.encode("utf-8")
    if has_bom:
        payload = b"\xef\xbb\xbf" + payload
    return gzip.compress(payload, mtime=0) if is_gzip else payload


def _is_reparse_point(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    attrs = getattr(st, "st_file_attributes", 0)
    return bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def validate_safe_path(path: str | Path) -> Path:
    raw = os.fspath(path)
    if not raw or not raw.strip():
        raise LyzError("경로가 비어 있습니다.")
    if raw.startswith("\\\\") or raw.startswith("//"):
        raise LyzError("UNC 경로는 허용되지 않습니다.")
    drive, tail = os.path.splitdrive(raw)
    if ":" in tail or (":" in raw and not (len(drive) == 2 and drive[1] == ":")):
        raise LyzError("NTFS 대체 데이터 스트림 경로는 허용되지 않습니다.")

    for part in re.split(r"[\\/]+", raw):
        if not part or part in (".", ".."):
            continue
        stem = part.split(".", 1)[0].rstrip(" ").lower()
        if stem in {"con", "prn", "aux", "nul"} or re.fullmatch(r"(?:com|lpt)[1-9]", stem):
            raise LyzError(f"Windows 예약 장치 이름은 허용되지 않습니다: {part}")

    candidate = Path(os.path.abspath(raw))
    for item in [candidate, *candidate.parents]:
        if _is_reparse_point(item):
            raise LyzError(f"심볼릭 링크 또는 재분석 지점은 허용되지 않습니다: {item}")
        try:
            st = os.lstat(item)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise LyzError(f"경로를 확인할 수 없습니다: {item}") from exc
        if st.st_nlink > 1 and not item.is_dir():
            raise LyzError(f"하드 링크는 허용되지 않습니다: {item}")
    return candidate


def is_game_running() -> bool:
    if os.environ.get("LYZ_SIMULATE_GAME_RUNNING") == "1":
        return True
    needle = "longyinlizhizhuan"
    try:
        if platform.system() == "Windows":
            res = subprocess.run(
                ["tasklist", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if res.returncode != 0:
                return True
            return needle in res.stdout.lower()
        res = subprocess.run(
            ["ps", "-A", "-o", "args="],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if res.returncode != 0:
            return True
        return needle in res.stdout.lower()
    except (OSError, subprocess.SubprocessError):
        return True


def _require_game_stopped() -> None:
    if is_game_running():
        raise LyzError("게임이 실행 중이므로 세이브를 변경할 수 없습니다.")


def _slot_file_paths(slot_dir: str | Path) -> tuple[Path, dict[str, Path]]:
    root = validate_safe_path(slot_dir)
    if not root.is_dir():
        raise LyzError(f"슬롯 디렉터리가 없습니다: {root}")
    return root, {name: validate_safe_path(root / name) for name in KNOWN_FILES}


def _load_slot(slot_dir: str | Path) -> tuple[Path, dict[str, Path], dict[str, dict[str, Any]], dict[str, Any]]:
    root, paths = _slot_file_paths(slot_dir)
    files: dict[str, dict[str, Any]] = {}
    parsed: dict[str, Any] = {}
    for name, path in paths.items():
        if not path.is_file():
            raise LyzError(f"필수 슬롯 파일이 없습니다: {name}")
        files[name] = read_slot_file(path)
        try:
            parsed[name] = json.loads(files[name]["text"])
        except json.JSONDecodeError as exc:
            raise LyzError(f"{name} 파일의 JSON 형식이 잘못되었습니다.") from exc
    return root, paths, files, parsed


def _find_player_hero(hero_list: Any) -> dict[str, Any] | None:
    if not isinstance(hero_list, list):
        return None
    matches = [h for h in hero_list if isinstance(h, dict) and h.get("heroID") == 0]
    if len(matches) == 1:
        return matches[0]
    return None


def inspect_slot(slot_dir: str | Path) -> dict[str, Any]:
    root, _, files, parsed = _load_slot(slot_dir)
    info = parsed["Info"] if isinstance(parsed["Info"], dict) else {}
    save = parsed["Save"] if isinstance(parsed["Save"], dict) else {}
    heroes = parsed["Hero"] if isinstance(parsed["Hero"], list) else []
    temp_heroes = parsed["TempHero"] if isinstance(parsed["TempHero"], list) else []
    player = _find_player_hero(heroes) or {}
    inv = player.get("itemListData") if isinstance(player.get("itemListData"), dict) else {}
    return {
        "slot": str(root),
        "version": info.get("SaveVersion"),
        "saveTime": info.get("SaveTime"),
        "saveDetail": info.get("SaveDetail"),
        "worldTime": save.get("worldTime"),
        "player": {
            "heroID": player.get("heroID"),
            "name": player.get("heroName") or player.get("heroFamilyName"),
            "force": player.get("belongForceID"),
            "money": inv.get("money"),
            "area": player.get("atAreaID"),
            "fame": player.get("fame"),
        },
        "heroCount": sum(1 for h in heroes if h is not None),
        "tempHeroCount": sum(1 for h in temp_heroes if h is not None),
        "gzip": {name: files[name]["isGzip"] for name in KNOWN_FILES},
    }


def validate_slot(slot_dir: str | Path) -> tuple[bool, str]:
    try:
        _, _, _, parsed = _load_slot(slot_dir)
        if not isinstance(parsed["Info"], dict) or not isinstance(parsed["Save"], dict):
            raise LyzError("Info 또는 Save 형식이 객체가 아닙니다.")
        hero = _find_player_hero(parsed["Hero"])
        if hero is None:
            raise LyzError("플레이어 영웅(heroID=0)을 찾을 수 없거나 중복되었습니다.")
        for key, expected in (
            ("baseAttri", 6), ("maxAttri", 6),
            ("baseFightSkill", 9), ("maxFightSkill", 9),
            ("baseLivingSkill", 9), ("maxLivingSkill", 9),
        ):
            val = hero.get(key)
            if val is not None and (not isinstance(val, list) or len(val) != expected):
                raise LyzError(f"플레이어 영웅 {key} 길이가 올바르지 않습니다 (기대 {expected}).")
        return True, "유효한 슬롯입니다."
    except LyzError as exc:
        return False, str(exc)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_verified(source: Path, destination: Path) -> None:
    shutil.copy2(source, destination)
    if _sha256(source) != _sha256(destination):
        raise LyzError(f"백업 SHA-256 검증에 실패했습니다: {source.name}")


def create_backup(slot_dir: str | Path) -> Path:
    root, paths = _slot_file_paths(slot_dir)
    backup_root = validate_safe_path(root.parent / ".lyz_backups")
    backup_root.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    backup = validate_safe_path(backup_root / f"{root.name}_{stamp}_{secrets.token_hex(4)}")
    backup.mkdir()
    try:
        for name in KNOWN_FILES:
            if not paths[name].is_file():
                raise LyzError(f"백업할 슬롯 파일이 없습니다: {name}")
            _copy_verified(paths[name], backup / name)
    except Exception:
        shutil.rmtree(backup, ignore_errors=True)
        raise
    backups = sorted(
        (item for item in backup_root.iterdir() if item.is_dir()),
        key=lambda item: item.stat().st_mtime_ns,
        reverse=True,
    )
    for old in backups[MAX_BACKUPS:]:
        shutil.rmtree(validate_safe_path(old))
    return backup


def _atomic_write(path: str | Path, content: bytes) -> None:
    p = validate_safe_path(path)
    fd, temp_name = tempfile.mkstemp(prefix=".lyz-", dir=str(p.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, p)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _restore_backup(backup: Path, root: Path) -> None:
    for name in KNOWN_FILES:
        source = validate_safe_path(backup / name)
        destination = validate_safe_path(root / name)
        if not source.is_file():
            raise LyzError(f"복구 백업 파일이 없습니다: {name}")
        _atomic_write(destination, source.read_bytes())
        if _sha256(source) != _sha256(destination):
            raise LyzError(f"복구 SHA-256 검증에 실패했습니다: {name}")


def _apply_edits(
    parsed: dict[str, Any],
    preset: str | None = None,
    money: int | None = None,
    fame: float | None = None,
    stone: int | None = None,
) -> None:
    if preset is not None and preset not in PRESETS:
        raise LyzError(f"알 수 없는 프리셋입니다: {preset}")
    save = parsed["Save"]
    hero = _find_player_hero(parsed["Hero"])
    if hero is None:
        raise LyzError("플레이어 영웅(heroID=0)을 찾을 수 없습니다.")
    inv = hero.get("itemListData")
    if not isinstance(inv, dict):
        raise LyzError("플레이어 소지품 자료를 찾을 수 없습니다.")

    if money is not None:
        inv["money"] = int(money)
    if fame is not None:
        hero["fame"] = float(fame)
    if stone is not None:
        save["speEnhanceStone"] = int(stone)

    if preset == "starter_boost":
        inv["money"] = int(inv.get("money", 0)) + 50000
        inv["maxWeight"] = float(inv.get("maxWeight", 0)) + 200.0
        hero["heroTagPoint"] = float(hero.get("heroTagPoint", 0)) + 500.0
        hero["fame"] = float(hero.get("fame", 0)) + 1000.0
    elif preset == "attribute_peak":
        for key in ("baseAttri", "maxAttri", "baseFightSkill", "maxFightSkill", "baseLivingSkill", "maxLivingSkill"):
            arr = hero.get(key)
            if isinstance(arr, list):
                hero[key] = [max(100.0, float(v)) for v in arr]
        hero["externalInjury"] = 0.0
        hero["internalInjury"] = 0.0
        hero["poisonInjury"] = 0.0
    elif preset == "martial_master":
        skills = hero.get("kungfuSkills")
        if isinstance(skills, list):
            for sk in skills:
                if isinstance(sk, dict):
                    sk["lv"] = 10
    elif preset == "world_harmony":
        hero["badFame"] = 0.0
        save["totalBadFame"] = 0.0
        save["cheating"] = False
        save["cheated"] = False


def save_slot_files(
    slot_dir: str | Path,
    file_payloads: dict[str, dict[str, Any]],
    *,
    no_backup: bool = False,
) -> dict[str, Any]:
    _require_game_stopped()
    root, paths = _slot_file_paths(slot_dir)
    for name in KNOWN_FILES:
        if name not in file_payloads or not isinstance(file_payloads[name].get("text"), str):
            raise LyzError(f"필수 파일 페이로드가 없습니다: {name}")
        try:
            json.loads(file_payloads[name]["text"])
        except json.JSONDecodeError as exc:
            raise LyzError(f"{name} JSON 형식이 올바르지 않습니다.") from exc

    backup = None if no_backup else create_backup(root)
    original = {name: paths[name].read_bytes() for name in KNOWN_FILES if paths[name].is_file()}
    try:
        for name in KNOWN_FILES:
            entry = file_payloads[name]
            raw_bytes = _encode_slot_text(entry["text"], bool(entry.get("isGzip")), bool(entry.get("hasBom")))
            _atomic_write(paths[name], raw_bytes)
    except Exception as exc:
        try:
            if backup is not None:
                _restore_backup(backup, root)
            else:
                for name, data in original.items():
                    _atomic_write(paths[name], data)
        except Exception as rollback_exc:
            raise LyzError(f"슬롯 저장 실패 후 복구도 실패했습니다: {rollback_exc}") from exc
        raise LyzError("슬롯 저장에 실패하여 원본을 복구했습니다.") from exc
    return {"slot": str(root), "backup": str(backup) if backup else None}


def edit_slot(
    slot_dir: str | Path,
    preset: str | None = None,
    money: int | None = None,
    fame: float | None = None,
    stone: int | None = None,
    compression: bool | None = None,
    no_backup: bool = False,
) -> dict[str, Any]:
    _require_game_stopped()
    _, _, files, parsed = _load_slot(slot_dir)
    _apply_edits(parsed, preset, money, fame, stone)
    payloads = {}
    for name in KNOWN_FILES:
        compressed = files[name]["isGzip"] if compression is None else compression
        text = json.dumps(parsed[name], ensure_ascii=False, separators=(",", ":"))
        payloads[name] = {
            "text": text,
            "isGzip": compressed,
            "hasBom": files[name]["hasBom"],
        }
    return save_slot_files(slot_dir, payloads, no_backup=no_backup)


def _resolve_save_root(save_dir: str | Path) -> Path:
    root = validate_safe_path(save_dir)
    if root.is_dir() and any(
        item.is_dir() and all((item / name).is_file() for name in KNOWN_FILES)
        for item in root.iterdir()
    ):
        return root
    backup_candidate = validate_safe_path(root.parent / "Save_backup")
    if backup_candidate.is_dir() and any(
        item.is_dir() and all((item / name).is_file() for name in KNOWN_FILES)
        for item in backup_candidate.iterdir()
    ):
        return backup_candidate
    return root


def list_slots(save_dir: str | Path) -> list[dict[str, Any]]:
    candidate = _resolve_save_root(save_dir)
    if not candidate.is_dir():
        return []
    slots = []
    for item in sorted(candidate.iterdir(), key=lambda p: p.name.lower()):
        if item.is_dir() and all((item / name).is_file() for name in KNOWN_FILES):
            slots.append({"name": item.name, "path": str(item)})
    return slots


def _backup_list(save_dir: str | Path) -> list[dict[str, Any]]:
    root = _resolve_save_root(save_dir)
    backup_root = validate_safe_path(root / ".lyz_backups")
    if not backup_root.is_dir():
        return []
    result = []
    for item in sorted(backup_root.iterdir(), key=lambda p: p.stat().st_mtime_ns, reverse=True):
        if item.is_dir() and all((item / name).is_file() for name in KNOWN_FILES):
            result.append({"name": item.name, "path": str(item)})
    return result


class LyzHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _find_editor_page() -> Path | None:
    base = Path(__file__).resolve().parent
    for candidate in (
        base / "dist" / "LongYinSaveEditor-v1.0.0.html",
        base / "src" / "editor-page.html",
    ):
        if candidate.is_file():
            return candidate
    return None


def make_handler(save_dir: str | Path, token: str):
    save_root = _resolve_save_root(save_dir)

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "LyzEditor/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send(self, status: int, payload: Any, content_type: str = "application/json; charset=utf-8") -> None:
            body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, message: str) -> None:
            self._send(status, {"error": message})

        def _validate_request(self, require_token: bool = False) -> None:
            host = self.headers.get("Host", "")
            try:
                hostname = urllib.parse.urlsplit("//" + host).hostname
            except ValueError:
                hostname = None
            if hostname not in ("127.0.0.1", "localhost", "::1"):
                raise LyzError("로컬호스트 요청만 허용됩니다.")

            origin = self.headers.get("Origin")
            if origin:
                parsed_origin = urllib.parse.urlsplit(origin)
                if parsed_origin.hostname not in ("127.0.0.1", "localhost", "::1"):
                    raise LyzError("다른 출처의 요청은 허용되지 않습니다.")
                if parsed_origin.port not in (None, self.server.server_port):
                    raise LyzError("다른 포트의 출처 요청은 허용되지 않습니다.")

            fetch_site = self.headers.get("Sec-Fetch-Site")
            if fetch_site and fetch_site not in ("same-origin", "none"):
                raise LyzError("동일 출처 요청만 허용됩니다.")

            if require_token:
                supplied = self.headers.get("X-Lyz-Token", "")
                if not secrets.compare_digest(supplied, token):
                    raise LyzError("API 인증 토큰이 올바르지 않습니다.")

        def _body(self) -> dict[str, Any]:
            length = self.headers.get("Content-Length")
            if length is None or not length.isdigit():
                raise LyzError("요청 본문 길이가 올바르지 않습니다.")
            size = int(length)
            if size > MAX_BODY:
                raise LyzError("요청 본문이 64MB 제한을 초과했습니다.")
            data = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(data, dict):
                raise LyzError("요청 데이터 형식이 올바르지 않습니다.")
            return data

        def do_GET(self) -> None:
            try:
                self._validate_request(require_token=urllib.parse.urlsplit(self.path).path.startswith("/api/"))
                url = urllib.parse.urlsplit(self.path)
                query = urllib.parse.parse_qs(url.query)
                if url.path == "/":
                    page = _find_editor_page()
                    if page is None:
                        return self._error(404, "편집기 HTML 파일을 찾을 수 없습니다.")
                    html = page.read_text(encoding="utf-8")
                    meta = f'<meta name="lyz-api-token" content="{token}">'
                    html = re.sub(r"<head([^>]*)>", lambda m: m.group(0) + meta, html, count=1, flags=re.IGNORECASE)
                    html = re.sub(
                        r"(?i)(connect-src\s+'none')",
                        "connect-src 'self'",
                        html,
                    )
                    return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
                if url.path == "/api/health":
                    return self._send(200, {"ok": True})
                if url.path == "/api/slots":
                    return self._send(200, {"slots": list_slots(save_root)})
                if url.path == "/api/slot":
                    name = query.get("name", [""])[0]
                    if not name or Path(name).name != name:
                        raise LyzError("슬롯 이름이 올바르지 않습니다.")
                    slot = validate_safe_path(save_root / name)
                    _, _, files, _ = _load_slot(slot)
                    return self._send(200, {
                        "name": name,
                        "summary": inspect_slot(slot),
                        "files": {
                            k: {"text": v["text"], "isGzip": v["isGzip"], "hasBom": v["hasBom"]}
                            for k, v in files.items()
                        },
                    })
                if url.path == "/api/backups":
                    return self._send(200, {"backups": _backup_list(save_root)})
                return self._error(404, "요청한 경로를 찾을 수 없습니다.")
            except LyzError as exc:
                status = 403 if "토큰" in str(exc) or "출처" in str(exc) or "로컬호스트" in str(exc) else 400
                return self._error(status, str(exc))
            except (OSError, ValueError, json.JSONDecodeError):
                return self._error(400, "요청을 처리할 수 없습니다.")

        def do_POST(self) -> None:
            try:
                self._validate_request(require_token=True)
                url = urllib.parse.urlsplit(self.path)
                payload = self._body()
                if url.path == "/api/save":
                    name = payload.get("name")
                    if not isinstance(name, str) or not name or Path(name).name != name:
                        raise LyzError("슬롯 이름이 올바르지 않습니다.")
                    slot = validate_safe_path(save_root / name)
                    if isinstance(payload.get("files"), dict):
                        result = save_slot_files(slot, payload["files"])
                    else:
                        result = edit_slot(
                            slot,
                            preset=payload.get("preset"),
                            money=payload.get("money"),
                            fame=payload.get("fame"),
                            stone=payload.get("stone"),
                            compression=payload.get("gzip"),
                        )
                    result["backups"] = _backup_list(save_root)
                    return self._send(200, result)
                if url.path == "/api/restore":
                    _require_game_stopped()
                    backup_name = payload.get("backup")
                    if not isinstance(backup_name, str) or Path(backup_name).name != backup_name:
                        raise LyzError("백업 이름이 올바르지 않습니다.")
                    backup = validate_safe_path(save_root / ".lyz_backups" / backup_name)
                    slot_name = backup_name.split("_", 1)[0]
                    slot = validate_safe_path(save_root / slot_name)
                    if not backup.is_dir() or not slot.is_dir():
                        raise LyzError("백업 또는 슬롯 디렉터리를 찾을 수 없습니다.")
                    _restore_backup(backup, slot)
                    _, _, files, _ = _load_slot(slot)
                    return self._send(200, {
                        "restored": backup_name,
                        "slot": slot_name,
                        "files": {
                            k: {"text": v["text"], "isGzip": v["isGzip"], "hasBom": v["hasBom"]}
                            for k, v in files.items()
                        },
                    })
                return self._error(404, "요청한 경로를 찾을 수 없습니다.")
            except LyzError as exc:
                status = 403 if "토큰" in str(exc) or "출처" in str(exc) or "로컬호스트" in str(exc) else 400
                return self._error(status, str(exc))
            except (OSError, ValueError, json.JSONDecodeError):
                return self._error(400, "요청을 처리할 수 없습니다.")

    return Handler


def serve(save_dir: str | Path = DEFAULT_SAVE_DIR, port: int = 0, no_browser: bool = False) -> None:
    save_root = validate_safe_path(save_dir)
    save_root.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    server = LyzHTTPServer(("127.0.0.1", port), make_handler(save_root, token))
    address = f"http://127.0.0.1:{server.server_port}/"
    print(f"로컬 서버 주소: {address}")
    if not no_browser:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def _synthetic_slot(root: Path, compressed: bool = False) -> None:
    root.mkdir(parents=True, exist_ok=True)
    sample = {
        "Info": {"SaveVersion": "1.1.3 f0", "SaveDetail": "점검 슬롯", "SaveTime": "2026-11-20"},
        "Save": {
            "chapter": 1,
            "gameMode": 0,
            "gameDifficulty": 2,
            "worldTime": {"year": 2, "month": 1, "day": 1},
            "speEnhanceStone": 5,
            "Forces": [],
            "Areas": [],
        },
        "Hero": [{
            "heroID": 0,
            "heroFamilyName": "강",
            "heroName": "용운",
            "belongForceID": 25,
            "atAreaID": 8,
            "fame": 100.0,
            "itemListData": {"money": 10, "maxWeight": 400.0, "allItem": []},
            "baseAttri": [50.0] * 6,
            "maxAttri": [80.0] * 6,
            "baseFightSkill": [50.0] * 9,
            "maxFightSkill": [80.0] * 9,
            "baseLivingSkill": [40.0] * 9,
            "maxLivingSkill": [80.0] * 9,
        }],
        "TempHero": [],
    }
    for name, value in sample.items():
        text = json.dumps(value, ensure_ascii=False)
        _atomic_write(root / name, _encode_slot_text(text, compressed, False))


def self_test() -> None:
    import time as _t
    with tempfile.TemporaryDirectory(prefix="lyz-test-") as temp:
        base = Path(temp)
        plain = base / "SaveSlot0"
        zipped = base / "SaveSlot1"
        _synthetic_slot(plain, False)
        _synthetic_slot(zipped, True)

        assert all(read_slot_file(plain / name)["isGzip"] is False for name in KNOWN_FILES)
        assert all(read_slot_file(zipped / name)["isGzip"] is True for name in KNOWN_FILES)
        assert inspect_slot(plain)["player"]["name"] == "용운"
        assert validate_slot(plain)[0]
        result = edit_slot(plain, money=500)
        assert result["backup"] and (Path(result["backup"]) / "Info").is_file()
        assert json.loads(read_slot_file(plain / "Hero")["text"])[0]["itemListData"]["money"] == 500
        _restore_backup(Path(result["backup"]), plain)
        assert json.loads(read_slot_file(plain / "Hero")["text"])[0]["itemListData"]["money"] == 10
        for bad in (r"\\server\share", "//server/share", "C:\\temp\\file:stream", "con.txt"):
            try:
                validate_safe_path(bad)
            except LyzError:
                pass
            else:
                raise AssertionError(f"안전하지 않은 경로가 거부되지 않았습니다: {bad}")
        os.environ["LYZ_SIMULATE_GAME_RUNNING"] = "1"
        try:
            try:
                edit_slot(plain, money=1)
            except LyzError:
                pass
            else:
                raise AssertionError("실행 중인 게임의 세이브 편집이 거부되지 않았습니다.")
        finally:
            os.environ.pop("LYZ_SIMULATE_GAME_RUNNING", None)
    print("자체 점검 완료: 모든 항목 통과")


def _nonnegative_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("0 이상의 정수를 입력하세요.") from exc
    if number < 0:
        raise argparse.ArgumentTypeError("0 이상의 정수를 입력하세요.")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="용윤입지전 세이브 슬롯 편집기")
    parser.add_argument("--self-test", action="store_true", help="내장 자체 점검을 실행합니다.")
    sub = parser.add_subparsers(dest="command")

    inspect_parser = sub.add_parser("inspect", help="슬롯 정보를 확인합니다.")
    inspect_parser.add_argument("slot_dir")

    validate_parser = sub.add_parser("validate", help="슬롯 파일을 검증합니다.")
    validate_parser.add_argument("slot_dir")

    sub.add_parser("presets", help="사용 가능한 편집 프리셋을 표시합니다.")

    edit_parser = sub.add_parser("edit", help="슬롯 값을 안전하게 편집합니다.")
    edit_parser.add_argument("slot_dir")
    edit_parser.add_argument("--preset", choices=PRESETS)
    edit_parser.add_argument("--money", type=_nonnegative_int)
    edit_parser.add_argument("--fame", type=float)
    edit_parser.add_argument("--stone", type=_nonnegative_int)
    compression = edit_parser.add_mutually_exclusive_group()
    compression.add_argument("--gzip", dest="compression", action="store_true")
    compression.add_argument("--plain", dest="compression", action="store_false")
    edit_parser.set_defaults(compression=None)
    edit_parser.add_argument("--no-backup", action="store_true")

    serve_parser = sub.add_parser("serve", help="루프백 웹 편집기를 실행합니다.")
    serve_parser.add_argument("--save-dir", default=str(DEFAULT_SAVE_DIR))
    serve_parser.add_argument("--port", type=int, default=0)
    serve_parser.add_argument("--no-browser", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            self_test()
            return 0
        if args.command == "inspect":
            print(json.dumps(inspect_slot(args.slot_dir), ensure_ascii=False, indent=2))
            return 0
        if args.command == "validate":
            valid, message = validate_slot(args.slot_dir)
            print(message)
            return 0 if valid else 1
        if args.command == "presets":
            print(json.dumps({"presets": list(PRESETS)}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "edit":
            result = edit_slot(
                args.slot_dir, preset=args.preset, money=args.money, fame=args.fame,
                stone=args.stone, compression=args.compression, no_backup=args.no_backup,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "serve":
            if not 0 <= args.port <= 65535:
                raise LyzError("포트는 0부터 65535 사이여야 합니다.")
            serve(args.save_dir, args.port, args.no_browser)
            return 0
        parser.print_help()
        return 0
    except LyzError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError, json.JSONDecodeError):
        print("오류: 요청을 처리할 수 없습니다.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
