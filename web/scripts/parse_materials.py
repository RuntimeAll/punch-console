"""一次性桥:复用 v1 根目录的 materials.py,把各册 _交付/发布物料*.md 解析成 JSON。

只读不写原目录;结果落 web/.data/materials.json 给 TS 导入脚本吃。
    python scripts/parse_materials.py

铁律:不改 v1 任何文件(v1 还在 :8787 服役);解析不了的册跳过并计数,不抛异常。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent          # web/scripts
WEB = HERE.parent                                # web
REPO = WEB.parent                                # punch-console(v1 代码在这)
sys.path.insert(0, str(REPO))

import data as v1data          # noqa: E402  v1 产线卡数据层
import materials as v1mat      # noqa: E402  v1 物料解析层

OUT = WEB / ".data" / "materials.json"


def has_copy(copy: dict) -> bool:
    return bool((copy.get("标题") or "").strip() or (copy.get("正文") or "").strip())


# ---------------------------------------------------------------- 老册容错(本脚本本地补,不改 v1)
# v1 的 _fallback_single 按「## 标题」开头匹配,老册写成「## 二、标题（三选一）」就漏了。

RE_NUM_HEAD = re.compile(r"^[一二三四五六七八九十]+\s*[、.．]\s*")


def _plain_head(head: str) -> str:
    return RE_NUM_HEAD.sub("", head.replace("#", "").strip())


def _numbered_sections(text: str) -> dict:
    """老册「二、标题 / 三、正文 / 四、标签」格式。"""
    item = v1mat.empty_copy()
    for head, body in v1mat._sections(text):
        h = _plain_head(head)
        if h.startswith("标题") and not item["标题"]:
            # 「三选一」候选表里取第一个加粗项,没有就取第一行
            m = re.search(r"\*\*(.+?)\*\*", body)
            if m:
                item["标题"] = v1mat._clean_title(m.group(1))
            else:
                for ln in body.strip().splitlines():
                    if ln.strip():
                        item["标题"] = v1mat._clean_title(ln)
                        break
        elif h.startswith("正文") and not item["正文"]:
            blocks = [b for b in v1mat._code_blocks(body) if "百度网盘" not in b]
            item["正文"] = (blocks[0] if blocks else body).strip()
        elif ("标签" in h or "话题" in h) and not item["话题"]:
            item["话题"] = v1mat._topics_from(body)
    return item


def _plain_copy_section(text: str) -> dict:
    """老册「## 参考文案」裸文本格式:首行当标题,井号行当话题,其余当正文。"""
    for head, body in v1mat._sections(text):
        if "文案" not in _plain_head(head):
            continue
        tags: list[str] = []
        content: list[str] = []
        for ln in (l.strip() for l in body.strip().splitlines()):
            if not ln:
                continue
            if ln.startswith("#") and not ln.startswith("##"):
                tags.extend(v1mat.RE_HASHTAG.findall(ln))
            else:
                content.append(ln)
        if not content:
            continue
        item = v1mat.empty_copy()
        item["标题"] = v1mat._clean_title(content[0])
        item["正文"] = "\n".join(content[1:]) if len(content) > 1 else content[0]
        item["话题"] = tags
        return item
    return v1mat.empty_copy()


def rescue(path: Path) -> dict:
    """v1 抽空了才走这里,依次试两种老册格式。"""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return v1mat.empty_copy()
    for fn in (_numbered_sections, _plain_copy_section):
        try:
            item = fn(text)
        except Exception:
            continue
        if has_copy(item):
            return item
    return v1mat.empty_copy()


def main() -> None:
    books = v1data.list_book_dirs()
    print(f"[parse] 册目录 {len(books)} 个,根 = {v1data.PUNCH_ROOT}")

    rows: list[dict] = []
    ok_books, skip_books = 0, 0
    skipped: list[str] = []

    for bdir in books:
        card = v1data.load_card(bdir.name)
        # 产线卡里登记的物料文件优先(版本 -> 文件),没登记再扫目录
        planned: list[tuple[str, Path]] = []
        if card:
            for v in card.get("版本", []):
                rel = (v.get("物料文件") or "").strip()
                if rel:
                    p = bdir / rel
                    if p.is_file():
                        planned.append((v.get("key") or "正册", p))
        if not planned:
            for p in v1mat.find_material_files(bdir):
                planned.append((v1mat.version_key_of(p), p))

        if not planned:
            skip_books += 1
            skipped.append(f"{bdir.name}(无物料文件)")
            continue

        got_any = False
        for version_key, p in planned:
            res = v1mat.parse_material(p)
            a, b = res["文案"]["A"], res["文案"]["B"]
            if not (has_copy(a) or has_copy(b)):
                a = rescue(p)          # 老册格式兜底
                if not has_copy(a):
                    continue
            got_any = True
            rows.append(
                {
                    "册名": bdir.name,
                    "版本": version_key,
                    "文件": str(p),
                    "分享语": res["分享语"],
                    "网盘": res["网盘"],
                    "book_id": res["book_id"],
                    "商品描述": res["商品描述"],
                    "文案": {"A": a, "B": b},
                }
            )
        if got_any:
            ok_books += 1
        else:
            skip_books += 1
            skipped.append(f"{bdir.name}(A/B 文案都抽不到)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(
            {"rows": rows, "ok_books": ok_books, "skip_books": skip_books, "skipped": skipped},
            f,
            ensure_ascii=False,
            indent=1,
        )

    print(f"[parse] 成功 {ok_books} 册 / 跳过 {skip_books} 册 / 物料条目 {len(rows)}")
    for s in skipped:
        print(f"  skip: {s}")
    print(f"[parse] 落盘 {OUT}")


if __name__ == "__main__":
    main()
