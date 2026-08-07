"""PDF 合并（pymupdf）。汇总多册成品 PDF 成一份下载件。"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pymupdf as fitz


def merge_pdfs(paths: list[Path], out_path: Path) -> Path:
    """按给定顺序合并 PDF，写到 out_path。坏文件跳过。"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    try:
        for p in paths:
            try:
                with fitz.open(str(p)) as src:
                    doc.insert_pdf(src)
            except Exception:
                continue
        doc.save(str(out_path))
    finally:
        doc.close()
    return out_path


def merge_to_temp(paths: list[Path], file_name: str) -> Path:
    """合并到临时目录，返回文件路径（供 ui.download 用）。"""
    tmp = Path(tempfile.mkdtemp(prefix="punch-merge-"))
    return merge_pdfs(paths, tmp / file_name)


def page_count(path: Path) -> int:
    """页数，读不出返回 0。"""
    try:
        with fitz.open(str(path)) as doc:
            return doc.page_count
    except Exception:
        return 0
