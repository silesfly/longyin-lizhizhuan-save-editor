#!/usr/bin/env python3
"""용윤입지전 세이브 에디터 단일 HTML 번들 빌드 스크립트."""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / "src"
EDITOR_PAGE = SRC_DIR / "editor-page.html"
DIST_DIR = ROOT / "dist"
OUTPUT_NAME = "LongYinSaveEditor-v1.0.0.html"
OUTPUT_PATH = DIST_DIR / OUTPUT_NAME

SCRIPT_ORDER = [
    "catalog-data.js",
    "lyz-codec.js",
    "editor-core.js",
    "editor-ui.js",
]

MAX_SIZE = 10 * 1024 * 1024

RE_SCRIPT_SRC = re.compile(r"<script\b[^>]*\bsrc\s*=", re.IGNORECASE)
RE_INLINE_SCRIPT_TAG = re.compile(
    r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script\s*>",
    re.IGNORECASE | re.DOTALL,
)
RE_SRC_ATTR = re.compile(
    r"\bsrc\s*=\s*(?P<quote>['\"]?)(?P<src>[^'\"\s>]+)(?P=quote)",
    re.IGNORECASE,
)
RE_CSP_META = re.compile(
    r"<meta\b[^>]*\bhttp-equiv\s*=\s*(?P<q1>['\"]?)Content-Security-Policy(?P=q1)[^>]*>",
    re.IGNORECASE,
)
RE_CONTENT_ATTR = re.compile(
    r"\bcontent\s*=\s*(?P<quote>['\"])(?P<content>.*?)(?P=quote)",
    re.IGNORECASE | re.DOTALL,
)
RE_EXTERNAL_URL = re.compile(r"https?://|ftp://|wss?://|//[a-z0-9-]", re.IGNORECASE)
RE_HANZI = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002ebef]")
RE_KANA = re.compile(r"[\u3040-\u309f\u30a0-\u30ff]")
RE_DANGEROUS = re.compile(r"innerHTML|outerHTML|eval\(|new Function\(", re.IGNORECASE)


class BuildError(RuntimeError):
    """빌드 오류."""


def _inline_scripts(html: str) -> str:
    sources: dict[str, str] = {}
    for name in SCRIPT_ORDER:
        path = SRC_DIR / name
        if not path.is_file():
            raise BuildError(f"스크립트 파일을 찾을 수 없습니다: {path}")
        sources[name] = path.read_text(encoding="utf-8")

    inlined: set[str] = set()

    def replace_tag(match: re.Match[str]) -> str:
        attrs = match.group("attrs")
        src_match = RE_SRC_ATTR.search(attrs)
        if not src_match:
            return match.group(0)
        name = Path(src_match.group("src").strip()).name
        if name not in sources:
            return match.group(0)
        if name in inlined:
            raise BuildError(f"스크립트가 중복 삽입되었습니다: {name}")
        inlined.add(name)
        return f"<script>\n{sources[name]}\n</script>"

    html = RE_INLINE_SCRIPT_TAG.sub(replace_tag, html)
    missing = [name for name in SCRIPT_ORDER if name not in inlined]
    if missing:
        raise BuildError("인라인할 스크립트 태그를 찾지 못했습니다: " + ", ".join(missing))
    return html


def _validate_html(html: str) -> None:
    size = len(html.encode("utf-8"))
    if not (0 < size < MAX_SIZE):
        raise BuildError(f"출력 크기가 허용 범위를 벗어났습니다: {size} 바이트")
    if RE_SCRIPT_SRC.search(html):
        raise BuildError("외부 스크립트 태그가 남아 있습니다.")
    meta_match = RE_CSP_META.search(html)
    if not meta_match:
        raise BuildError("Content-Security-Policy 메타 태그가 없습니다.")
    content_match = RE_CONTENT_ATTR.search(meta_match.group(0))
    csp = " ".join((content_match.group("content") if content_match else "").lower().split())
    if "default-src 'none'" not in csp or "connect-src 'none'" not in csp:
        raise BuildError("CSP에 default-src 'none' 및 connect-src 'none'이 필요합니다.")
    if RE_EXTERNAL_URL.search(html):
        raise BuildError("외부 URL 문자열이 남아 있습니다.")
    if RE_HANZI.search(html):
        raise BuildError("한자가 남아 있습니다.")
    if RE_KANA.search(html):
        raise BuildError("가나 문자가 남아 있습니다.")
    if RE_DANGEROUS.search(html):
        raise BuildError("위험한 문자열이 남아 있습니다.")


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def build(*, check_only: bool = False) -> Path:
    if not EDITOR_PAGE.is_file():
        raise BuildError(f"원본 HTML을 찾을 수 없습니다: {EDITOR_PAGE}")
    assembled = _inline_scripts(EDITOR_PAGE.read_text(encoding="utf-8"))
    _validate_html(assembled)
    if check_only:
        if not OUTPUT_PATH.is_file():
            raise BuildError(f"번들 파일이 없습니다: {OUTPUT_PATH}")
        if OUTPUT_PATH.read_text(encoding="utf-8") != assembled:
            raise BuildError(f"번들 파일이 최신 소스와 다릅니다: {OUTPUT_PATH}")
        print(f"확인 완료: {OUTPUT_PATH} ({len(assembled.encode('utf-8')):,} B)")
        return OUTPUT_PATH
    _atomic_write(OUTPUT_PATH, assembled)
    print(f"빌드 완료: {OUTPUT_PATH} ({len(assembled.encode('utf-8')):,} B)")
    return OUTPUT_PATH


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="용윤입지전 세이브 에디터 빌드")
    parser.add_argument("--check", action="store_true", help="기존 번들 일치 및 정책 검증")
    args = parser.parse_args(argv)
    try:
        build(check_only=args.check)
        return 0
    except (OSError, BuildError) as exc:
        print(f"빌드 오류: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
