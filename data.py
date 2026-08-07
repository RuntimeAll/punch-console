"""产线卡数据层：扫描打卡数据根、读写 <册目录>/产线卡.json。

事实源 = 文件系统。本模块不缓存、不建库，每次读盘。
"""
from __future__ import annotations

import json
import os
import re
from datetime import date
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- 常量

# 数据根：默认打卡产物目录，可被环境变量 PUNCH_ROOT 覆盖
DEFAULT_PUNCH_ROOT = r"D:\workplace\ai-bkb\举一反三产物\打卡"
PUNCH_ROOT = Path(os.environ.get("PUNCH_ROOT", DEFAULT_PUNCH_ROOT))

# 产线卡文件名（每册一份）
CARD_NAME = "产线卡.json"

# 交付目录名（发布物料与小红书图都在这里）
DELIVER_DIR = "_交付"

# 队列目录（下单单据）
QUEUE_DIR = "_队列"
QUEUE_TODO = "待办"
QUEUE_DONE = "完成"

# 扫描时跳过的一级目录（下划线开头的都是工具/中间产物）
SKIP_DIRS = {"网盘分发记录"}

# 三步走的四个阶段（顺序即页面展示顺序）
STEPS = ["打样", "全册", "物料", "录prod"]

# 状态枚举
STATUSES = ["在产", "可发布", "在售", "停售"]

# 销售渠道枚举
CHANNELS = ["小红书A号", "小红书B号", "其他"]

# 册名 → 年级 的猜测表（长键在前，先匹配长的）
GRADE_PATTERNS: list[tuple[str, str]] = [
    ("三升四", "三升四"),
    ("四升五", "四升五"),
    ("五升六", "五升六"),
    ("六升七", "六升七"),
    ("二升三", "二升三"),
    ("一升二", "一升二"),
    ("七年级上册", "七年级上册"),
    ("七年级下册", "七年级下册"),
    ("八年级上册", "八年级上册"),
    ("八年级下册", "八年级下册"),
    ("一上", "一年级上册"),
    ("一下", "一年级下册"),
    ("二上", "二年级上册"),
    ("二下", "二年级下册"),
    ("三上", "三年级上册"),
    ("三下", "三年级下册"),
    ("四上", "四年级上册"),
    ("四下", "四年级下册"),
    ("五上", "五年级上册"),
    ("五下", "五年级下册"),
    ("六上", "六年级上册"),
    ("六下", "六年级下册"),
    ("七上", "七年级上册"),
    ("七下", "七年级下册"),
    ("八上", "八年级上册"),
    ("八下", "八年级下册"),
    ("九上", "九年级上册"),
    ("九下", "九年级下册"),
]


# ---------------------------------------------------------------- 基础工具


def read_json(path: Path) -> Any:
    """读 JSON，失败返回 None（绝不抛异常打断页面）。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_json(path: Path, obj: Any) -> None:
    """写 JSON，UTF-8、缩进 2、不转义中文。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def guess_grade(book_name: str) -> str:
    """从册名猜年级，猜不出留空。"""
    for key, grade in GRADE_PATTERNS:
        if key in book_name:
            return grade
    return ""


def guess_subject(book_name: str) -> str:
    """从册名猜科目，默认数学。"""
    if "科学" in book_name:
        return "科学"
    return "数学"


# ---------------------------------------------------------------- 册与卡


def book_dir(name: str) -> Path:
    """册名 → 册目录。"""
    return PUNCH_ROOT / name


def list_book_dirs() -> list[Path]:
    """扫 PUNCH_ROOT 下一级目录（跳过 _ 开头与 SKIP_DIRS）。"""
    if not PUNCH_ROOT.is_dir():
        return []
    out = []
    for p in sorted(PUNCH_ROOT.iterdir()):
        if not p.is_dir():
            continue
        if p.name.startswith("_") or p.name in SKIP_DIRS:
            continue
        out.append(p)
    return out


def new_version(key: str = "正册") -> dict:
    """一个空版本结构。"""
    return {
        "key": key,
        "book_id": "",
        "网盘": {"链接": "", "码": ""},
        "三步走": {s: "todo" for s in STEPS},
        "物料文件": "",
        "图目录": {"A": "", "B": ""},
        "销量": [],
    }


def new_card(name: str) -> dict:
    """一张最简产线卡。"""
    return {
        "name": name,
        "科目": guess_subject(name),
        "年级": guess_grade(name),
        "绑定": {"类型": "考点", "值": []},
        "状态": "在产",
        "版本": [new_version()],
    }


def normalize_card(card: dict, name: str) -> dict:
    """补齐缺失字段，保证页面不因老卡缺键而炸。"""
    card.setdefault("name", name)
    card.setdefault("科目", guess_subject(name))
    card.setdefault("年级", guess_grade(name))
    bind = card.get("绑定")
    if not isinstance(bind, dict):
        bind = {}
    bind.setdefault("类型", "考点")
    bind.setdefault("值", [])
    card["绑定"] = bind
    if card.get("状态") not in STATUSES:
        card["状态"] = "在产"
    versions = card.get("版本")
    if not isinstance(versions, list) or not versions:
        versions = [new_version()]
    fixed = []
    for v in versions:
        if not isinstance(v, dict):
            continue
        base = new_version(v.get("key") or "正册")
        base.update({k: val for k, val in v.items() if val is not None})
        pan = base.get("网盘") or {}
        base["网盘"] = {"链接": pan.get("链接", ""), "码": pan.get("码", "")}
        steps = base.get("三步走") or {}
        base["三步走"] = {s: steps.get(s, "todo") for s in STEPS}
        imgs = base.get("图目录") or {}
        base["图目录"] = {"A": imgs.get("A", ""), "B": imgs.get("B", "")}
        sales = base.get("销量")
        if not isinstance(sales, list):
            sales = []
        # 销量行必须是字典：手改卡里混进一个字符串，version_sales 会 AttributeError，
        # 而看板要合计全部册的销量 —— 一行坏数据能把整个看板打成 500。
        base["销量"] = [r for r in sales if isinstance(r, dict)]
        fixed.append(base)
    # 手改卡把版本项写成了字符串（如 "版本": ["正册"]）会被上面整条滤掉，
    # 版本数组不能空——页面按 版本[0] 取首个 tab，空数组会 IndexError 打成 500。
    if not fixed:
        fixed = [new_version()]
    card["版本"] = fixed
    return card


def card_path(name: str) -> Path:
    return book_dir(name) / CARD_NAME


def load_card(name: str) -> dict | None:
    """读一张产线卡；没有卡返回 None。"""
    p = card_path(name)
    if not p.is_file():
        return None
    data = read_json(p)
    if not isinstance(data, dict):
        return None
    return normalize_card(data, name)


def save_card(card: dict) -> None:
    """写回产线卡。"""
    write_json(card_path(card["name"]), card)


def list_cards() -> list[dict]:
    """全部册的产线卡（无卡的册用最简卡兜底，不写盘）。"""
    out = []
    for d in list_book_dirs():
        card = load_card(d.name)
        if card is None:
            card = new_card(d.name)
        out.append(card)
    return out


# ---------------------------------------------------------------- 成品 PDF


def find_pdfs(name: str, version_key: str) -> list[Path]:
    """找某册某版本的成品 PDF，返回册目录下的相对路径。

    查找顺序：成品PDF/<版本>/ → 成品PDF/**（递归）→ 册根目录 *.pdf。
    多版本册在册根目录时按版本名过滤文件名。
    """
    root = book_dir(name)
    if not root.is_dir():
        return []
    files: list[Path] = []
    prod = root / "成品PDF"
    if prod.is_dir():
        sub = prod / version_key
        if sub.is_dir():
            files = sorted(sub.rglob("*.pdf"))
        else:
            files = sorted(prod.rglob("*.pdf"))
    if not files:
        flat = sorted(root.glob("*.pdf"))
        if version_key != "正册" and any(version_key in f.name for f in flat):
            flat = [f for f in flat if version_key in f.name]
        files = flat
    return [f.relative_to(root) for f in files]


def has_pdf(name: str, version_key: str) -> bool:
    return bool(find_pdfs(name, version_key))


# ---------------------------------------------------------------- 销量


def version_sales(version: dict) -> int:
    """单版本累计件数。"""
    total = 0
    for row in version.get("销量") or []:
        try:
            total += int(row.get("件数") or 0)
        except (TypeError, ValueError):
            continue
    return total


def card_sales(card: dict) -> int:
    """整册累计件数。"""
    return sum(version_sales(v) for v in card.get("版本", []))


def add_sale(name: str, version_key: str, day: str, qty: int, channel: str) -> dict:
    """追加一条销量记录并落盘，返回更新后的卡。"""
    card = load_card(name) or new_card(name)
    for v in card["版本"]:
        if v["key"] == version_key:
            v.setdefault("销量", []).append(
                {"日期": day or date.today().isoformat(), "件数": int(qty), "渠道": channel}
            )
            break
    save_card(card)
    return card


def set_step(name: str, version_key: str, step: str, done: bool) -> dict:
    """改三步走开关并落盘。"""
    card = load_card(name) or new_card(name)
    for v in card["版本"]:
        if v["key"] == version_key:
            v["三步走"][step] = "done" if done else "todo"
            break
    save_card(card)
    return card


# ---------------------------------------------------------------- 队列


def queue_dir(sub: str) -> Path:
    return PUNCH_ROOT / QUEUE_DIR / sub


def list_queue(sub: str) -> list[dict]:
    """列出队列某目录下的单据（按文件名倒序，新的在前）。"""
    d = queue_dir(sub)
    if not d.is_dir():
        return []
    rows = []
    for p in sorted(d.glob("*.json"), reverse=True):
        obj = read_json(p) or {}
        obj["_文件"] = p.name
        rows.append(obj)
    return rows


def create_order(payload: dict) -> Path:
    """写一张下单单据到 _队列/待办/<时间戳>-<册名>.json。"""
    from datetime import datetime

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r"[\\/:*?\"<>|]", "_", payload.get("册名") or "未命名")
    path = queue_dir(QUEUE_TODO) / f"{stamp}-{safe}.json"
    body = dict(payload)
    body["创建时间"] = stamp
    body["model"] = "opus"
    body["skill"] = "每日打卡"
    write_json(path, body)
    return path
