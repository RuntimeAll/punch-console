"""铺底脚本：扫 PUNCH_ROOT 下每一册，生成 产线卡.json。

幂等：已有卡默认跳过，--force 才重写。
用法：
    python bootstrap.py            # 只补没有卡的册
    python bootstrap.py --force    # 全部重算重写
    python bootstrap.py --dry-run  # 只看会生成什么，不写盘
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import data
import materials

if hasattr(sys.stdout, "reconfigure"):  # CLI 脚本：控制台按 utf-8 输出，防 GBK 炸
    sys.stdout.reconfigure(encoding="utf-8")


def build_card(bdir: Path) -> tuple[dict, str]:
    """按目录现状拼一张产线卡，返回 (卡, 说明)。"""
    name = bdir.name
    card = data.new_card(name)
    mds = materials.find_material_files(bdir)

    versions = []
    if mds:
        for md in mds:
            key = materials.version_key_of(md)
            v = data.new_version(key)
            parsed = materials.parse_material(md)
            v["book_id"] = parsed["book_id"]
            v["网盘"] = parsed["网盘"]
            v["物料文件"] = md.relative_to(bdir).as_posix()
            v["图目录"] = materials.find_image_dirs(bdir, key)
            versions.append(v)
    else:
        versions.append(data.new_version())

    # 三步走判定
    for v in versions:
        pdfs = data.find_pdfs(name, v["key"])
        if pdfs:
            v["三步走"]["打样"] = "done"
            v["三步走"]["全册"] = "done"
        if v.get("物料文件"):
            v["三步走"]["物料"] = "done"
        if v.get("book_id"):
            v["三步走"]["录prod"] = "done"

    card["版本"] = versions
    # 已有网盘链接的册视为在售，其余留在产
    if any(v["网盘"]["链接"] for v in versions):
        card["状态"] = "在售"

    if mds:
        kind = "物料卡(%d 版本)" % len(versions)
    else:
        kind = "最简卡"
    return card, kind


def main() -> int:
    ap = argparse.ArgumentParser(description="打卡产线卡铺底")
    ap.add_argument("--force", action="store_true", help="已有卡也重写")
    ap.add_argument("--dry-run", action="store_true", help="不写盘，只打印")
    args = ap.parse_args()

    root = data.PUNCH_ROOT
    print("[数据根] %s" % root)
    if not root.is_dir():
        print("[错误] 数据根不存在")
        return 1

    created, skipped, rewritten = [], [], []
    for bdir in data.list_book_dirs():
        exists = data.card_path(bdir.name).is_file()
        if exists and not args.force:
            skipped.append(bdir.name)
            print("[跳过] %s（已有卡）" % bdir.name)
            continue
        card, kind = build_card(bdir)
        if not args.dry_run:
            data.save_card(card)
        keys = "/".join(v["key"] for v in card["版本"])
        ids = ",".join(v["book_id"] or "-" for v in card["版本"])
        pans = ",".join(v["网盘"]["码"] or "-" for v in card["版本"])
        line = "[%s] %s | 年级=%s | %s | 版本=%s | book_id=%s | 提取码=%s" % (
            "重写" if exists else "新建",
            bdir.name,
            card["年级"] or "?",
            kind,
            keys,
            ids,
            pans,
        )
        print(line)
        (rewritten if exists else created).append(bdir.name)

    print("-" * 60)
    print("新建 %d 张，重写 %d 张，跳过 %d 张" % (len(created), len(rewritten), len(skipped)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
