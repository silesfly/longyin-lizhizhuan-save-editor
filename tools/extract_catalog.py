#!/usr/bin/env python3
"""Extract and validate catalog data for LongYinLiZhiZhuan."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any


HANZI_RE = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002ebef]"
)
KANA_RE = re.compile(r"[\u3040-\u30ff\uff66-\uff9f]")
CJK_RE = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002ebef"
    r"\u3040-\u30ff\uff66-\uff9f]+"
)
TAG_RE = re.compile(r"<[^>]*>")
ANGLE_RE = re.compile(r"[<>]")
PAREN_CJK_RE = re.compile(
    r"[\(（\[][^()（）\[\]]*"
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    r"\U00020000-\U0002ebef\u3040-\u30ff\uff66-\uff9f]"
    r"[^()（）\[\]]*[\)）\]]"
)

BASE_TERMS = {
    "攻击": "공격", "防御": "방어", "生命": "생명", "生命值": "생명력",
    "内力": "내력", "体力": "체력", "速度": "속도", "命中": "명중",
    "闪避": "회피", "暴击": "치명타", "暴击率": "치명타율",
    "暴击伤害": "치명타 피해", "伤害": "피해", "治疗": "치유",
    "恢复": "회복", "增加": "증가", "减少": "감소", "提升": "상승",
    "降低": "하락", "持续": "지속", "回合": "턴", "战斗": "전투",
    "攻击力": "공격력", "防御力": "방어력", "最大": "최대", "当前": "현재",
    "所有": "모든", "目标": "대상", "敌人": "적", "自身": "자신",
    "队友": "아군", "全体": "전체", "概率": "확률", "等级": "등급",
    "技能": "기술", "武功": "무공", "装备": "장비", "物品": "아이템",
    "药品": "약품", "食物": "음식", "武器": "무기", "护甲": "방어구",
    "坐骑": "탈것", "招式": "초식", "每次": "매회", "获得": "획득",
    "消耗": "소모", "无": "없음", "是": "예", "否": "아니요",
    "未知": "항목", "中庸": "중용", "邪恶": "사악", "正义": "정의",
    "善良": "선량", "守序": "질서", "混乱": "혼돈",
}

ENUMS = {
    "attriNames": ["완력", "민첩", "지력", "의지", "체질", "경맥"],
    "fightSkillNames": ["내공", "경공", "절기", "권장", "검법", "도법", "장병기", "기관술", "사술"],
    "livingSkillNames": ["의술", "독술", "학식", "말재주", "채벌", "재배", "단조", "제약", "요리"],
    "itemTypes": {
        "0": "장비", "1": "단약", "2": "음식/술", "3": "비급",
        "4": "진보", "5": "재료", "6": "명마/마구",
    },
    "equipSubTypes": {
        "0": "무기", "1": "갑옷", "2": "모자/투구", "3": "신발", "4": "장신구",
    },
    "rareLevels": ["평범", "우수", "정교", "희귀", "전설", "절세"],
    "gameModes": {"0": "스토리 모드", "1": "자유 모드"},
    "difficulties": {"0": "쉬움", "1": "보통", "2": "어려움", "3": "구사일생"},
}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def flatten_dictionary(value: Any) -> dict[str, str]:
    """Collect string-to-string pairs from dictionary JSON layouts."""
    result: dict[str, str] = {}

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, val in node.items():
                if isinstance(key, str) and isinstance(val, str):
                    result[key] = val
                elif isinstance(val, (dict, list)):
                    visit(val)
        elif isinstance(node, list):
            for item in node:
                if isinstance(item, dict):
                    source = item.get("source", item.get("zh", item.get("key")))
                    target = item.get("target", item.get("ko", item.get("value")))
                    if isinstance(source, str) and isinstance(target, str):
                        result[source] = target
                    visit(item)
                elif isinstance(item, list):
                    visit(item)

    visit(value)
    return result


def make_translator(dict_path: Path, extra_path: Path):
    translations = flatten_dictionary(load_json(dict_path))
    if extra_path.is_file():
        translations.update(flatten_dictionary(load_json(extra_path)))
    translations.update(BASE_TERMS)
    keys = sorted(translations, key=len, reverse=True)

    def translate(text: str) -> str:
        raw = (text or "").strip()
        if raw in translations:
            return clean_string(translations[raw])
        for key in keys:
            if key and key in raw:
                raw = raw.replace(key, translations[key])
        return clean_string(raw)

    return translate


def clean_string(value: str) -> str:
    value = TAG_RE.sub("", value)
    value = PAREN_CJK_RE.sub("", value)
    value = ANGLE_RE.sub("", value)
    value = CJK_RE.sub("", value)
    return re.sub(r"\s+", " ", value).strip()


def csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        return []
    header = [c.strip().lstrip("\ufeff") for c in rows[0]]
    out: list[dict[str, str]] = []
    for row in rows[1:]:
        if not row or not any(c.strip() for c in row):
            continue
        item = {}
        for i, col in enumerate(header):
            item[col] = row[i].strip() if i < len(row) else ""
        out.append(item)
    return out


def required(row: dict[str, str], keys: tuple[str, ...], filename: str) -> str:
    for k in keys:
        if k in row:
            return row[k]
    raise ValueError(f"{filename}: missing CSV column {keys!r}")


def csv_int(row: dict[str, str], keys: tuple[str, ...], filename: str) -> int:
    value = required(row, keys, filename).strip()
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{filename}: invalid integer in {keys!r}: {value!r}") from exc


def clean_tree(value: Any) -> Any:
    if isinstance(value, str):
        return clean_string(value)
    if isinstance(value, list):
        return [clean_tree(item) for item in value]
    if isinstance(value, dict):
        return {key: clean_tree(item) for key, item in value.items()}
    return value


def extract(
    corpus_dir: Path, tables_dir: Path, dict_path: Path, extra_dict_path: Path
) -> dict[str, Any]:
    translate = make_translator(dict_path, extra_dict_path)
    atlas = load_json(corpus_dir / "codex-atlas.json")["entries"]

    catalog: dict[str, Any] = {
        "kungfus": [], "tags": [], "speAdds": [], "horses": [], "weapons": [],
        "foods": [], "meds": [], "skins": [], "summons": [],
        "speHeroes": [], "achievements": [], "endings": [], "areas": [], "inns": [],
        "forces": [], "techs": [], "buildings": [], "resourcePoints": [],
        "armors": [], "enums": ENUMS,
    }

    target_by_prefix = {
        "kf": "kungfus", "tg": "tags", "sa": "speAdds", "hr": "horses",
        "wp": "weapons", "fd": "foods", "md": "meds", "sk": "skins", "sm": "summons",
    }
    for entry in atlas:
        prefix, raw_id = entry["id"].split("-", 1)
        if prefix not in target_by_prefix:
            continue
        item: dict[str, Any] = {"id": int(raw_id), "name": entry["name_ko"]}
        if prefix in {"kf", "tg"}:
            item.update(
                category=entry["sub_type"], tier=entry["tier"], effects=entry["effects"]
            )
        elif prefix == "sa":
            item.update(category=entry["sub_type"], effects=entry["effects"])
        elif prefix == "sk":
            item["effects"] = entry["effects"]
        else:
            item["tier"] = entry["tier"]
            item["effects"] = entry["effects"]
        catalog[target_by_prefix[prefix]].append(item)

    dashboard = load_json(corpus_dir / "companion-dashboard.json")
    for companion in dashboard["companions"]:
        catalog["speHeroes"].append({
            "id": int(companion["id"]),
            "name": companion["name_ko"],
            "type": companion["type"],
            "sect": companion["sect_ko"],
            "martial": companion["martial_ko"],
            "specialty": companion["specialty_ko"],
            "ultimate": companion["ultimate_ko"],
        })

    ach_data = load_json(corpus_dir / "achievement-inherit-atlas.json")
    ach_list = ach_data["achievements"] if isinstance(ach_data, dict) else ach_data
    for achievement in ach_list:
        item_id = achievement["id"]
        is_ach = item_id.startswith("ach-")
        catalog["achievements" if is_ach else "endings"].append({
            "id": int(item_id[4:]) if is_ach else item_id,
            "name": achievement["name_ko"],
            "category": achievement["category"],
            "desc": achievement["condition_ko"],
        })

    for pin in load_json(corpus_dir / "regional-map-atlas.json")["pins"]:
        item_id = pin["id"]
        if item_id.startswith("area-"):
            catalog["areas"].append({
                "id": int(item_id[5:]),
                "name": pin["name_ko"],
                "category": pin["category"],
                "summary": pin["summary_ko"],
            })
        elif item_id.startswith("inn-"):
            catalog["inns"].append({
                "id": int(item_id[4:]),
                "name": pin["name_ko"],
                "summary": pin["summary_ko"],
            })

    armor_rows = csv_rows(tables_dir / "ArmorData.txt")
    armor_atlas = [entry for entry in atlas if entry["id"].startswith("ar-")]
    for index, row in enumerate(armor_rows):
        if index >= len(armor_atlas):
            break
        armor = armor_atlas[index]
        catalog["armors"].append({
            "subType": csv_int(row, ("类别", "类别(1/2/3)"), "ArmorData.txt"),
            "id": csv_int(row, ("id",), "ArmorData.txt"),
            "name": armor["name_ko"],
            "effects": armor["effects"],
        })

    for row in csv_rows(tables_dir / "ForceData.txt"):
        fid = csv_int(row, ("id",), "ForceData.txt")
        name = translate(required(row, ("名字", "이름"), "ForceData.txt")) or f"세력 {fid}"
        style = translate(required(row, ("行事风格", "행동스타일"), "ForceData.txt")) or "중용"
        catalog["forces"].append({
            "id": fid,
            "name": name,
            "style": style,
            "lv": csv_int(row, ("等级", "등급"), "ForceData.txt"),
            "mainAreaId": csv_int(row, ("门派地点ID", "거점ID"), "ForceData.txt"),
        })

    for row in csv_rows(tables_dir / "TechDataBase.txt"):
        tid = csv_int(row, ("序号", "번호"), "TechDataBase.txt")
        name = translate(required(row, ("名称", "이름"), "TechDataBase.txt")) or f"기술 {tid}"
        desc = translate(required(row, ("描述", "설명"), "TechDataBase.txt"))
        catalog["techs"].append({"id": tid, "name": name, "desc": desc})

    for filename, key, prefix in (
        ("BuildingData.txt", "buildings", "건물"),
        ("ResourcePointData.txt", "resourcePoints", "자원점"),
    ):
        for row in csv_rows(tables_dir / filename):
            rid = csv_int(row, ("id",), filename)
            name = translate(required(row, ("名字", "이름"), filename)) or f"{prefix} {rid}"
            catalog[key].append({"id": rid, "name": name})

    return clean_tree(catalog)


def validate(catalog: dict[str, Any]) -> None:
    def inspect(value: Any, path: str = "$") -> None:
        if isinstance(value, str):
            if HANZI_RE.search(value):
                raise ValueError(f"Hanzi remains at {path}: {value!r}")
            if KANA_RE.search(value):
                raise ValueError(f"Kana remains at {path}: {value!r}")
            if "<" in value or ">" in value:
                raise ValueError(f"angle bracket remains at {path}: {value!r}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                inspect(item, f"{path}[{index}]")
        elif isinstance(value, dict):
            for key, item in value.items():
                inspect(key, f"{path}.<key>")
                inspect(item, f"{path}.{key}")

    inspect(catalog)
    for name, items in catalog.items():
        if not isinstance(items, list):
            continue
        if not items:
            raise ValueError(f"empty catalog category: {name}")
        seen: set[Any] = set()
        for item in items:
            if not isinstance(item, dict) or "id" not in item:
                continue
            identity = (item.get("subType"), item["id"]) if name == "armors" else item["id"]
            if identity in seen:
                raise ValueError(f"duplicate ID in {name}: {identity!r}")
            seen.add(identity)


def render(catalog: dict[str, Any]) -> str:
    payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    return (
        "(function(root,factory){"
        "if(typeof module==='object'&&module.exports){module.exports=factory();}"
        "else{root.LyzCatalogData=factory();}"
        "})(typeof globalThis!=='undefined'?globalThis:this,function(){"
        f"return {payload};"
        "});\n"
    )


def summarize(catalog: dict[str, Any]) -> str:
    return " ".join(
        f"{key}={len(value)}"
        for key, value in catalog.items()
        if isinstance(value, list)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus-dir",
        default="/home/jiyoung/workspace/무협위키/games/longyin-lizhizhuan/corpus",
    )
    parser.add_argument(
        "--tables-dir",
        default="/home/jiyoung/workspace/무협위키/.local/graph/longyin-data/latest_tables",
    )
    parser.add_argument(
        "--dict-path",
        default="/home/jiyoung/workspace/무협위키/.local/graph/longyin-data/longyin_ko_dict_final.json",
    )
    parser.add_argument(
        "--extra-dict-path",
        default="/home/jiyoung/workspace/무협위키/.local/graph/longyin-data/longyin_ko_extra.json",
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent.parent / "src" / "catalog-data.js"),
    )
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    try:
        catalog = extract(
            Path(args.corpus_dir), Path(args.tables_dir),
            Path(args.dict_path), Path(args.extra_dict_path),
        )
        validate(catalog)
        output = render(catalog)
        out_path = Path(args.out)
        if args.check_only:
            if not out_path.is_file():
                raise ValueError(f"--check-only output file is missing: {out_path}")
            if out_path.read_text(encoding="utf-8") != output:
                raise ValueError(f"--check-only output differs from {out_path}")
        else:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(output, encoding="utf-8")
        print(summarize(catalog))
        print("OK")
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
