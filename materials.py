"""发布物料 md 解析层。

针对 <册>/_交付/发布物料*.md 现行格式（三升四每日一练 2026-08-07 版）抽取：
网盘分享语 / book_id / A 版 B 版文案（标题·正文·话题）/ 商品上架描述 / 小红书图目录。

铁律：老册格式五花八门，抽不到只返回空字段，绝不抛异常打断页面。
"""
from __future__ import annotations

import re
from pathlib import Path

# 代码块（```lang\n ... ```）
RE_CODE = re.compile(r"```[^\n`]*\n(.*?)```", re.S)
# 二级标题行
RE_H2 = re.compile(r"^##[^#\n].*$", re.M)
# 网盘链接
RE_PAN = re.compile(r"https://pan\.baidu\.com/s/[A-Za-z0-9_\-]+(?:\?pwd=[A-Za-z0-9]+)?")
# 提取码
RE_PWD_Q = re.compile(r"[?&]pwd=([A-Za-z0-9]{4})")
RE_PWD_T = re.compile(r"提取码[：:\s]*([A-Za-z0-9]{4})")
# 雪花号 book_id
RE_BOOKID = re.compile(r"\b20\d{17}\b")
# 标题行 **标题**：xxx（容忍中间夹一段括号注释，如 **标题**（17 字，无 emoji）：xxx）
RE_TITLE = re.compile(r"\*\*标题\*\*\s*(?:[（(][^）)]*[)）])?\s*[：:]\s*(.+)")
# 话题行
RE_TOPIC = re.compile(r"^.*话题.*[：:](.+)$", re.M)
# 井号标签行
RE_HASHTAG = re.compile(r"#([^\s#]+)")


def empty_copy() -> dict:
    return {"标题": "", "正文": "", "话题": []}


def empty_result() -> dict:
    return {
        "文件": "",
        "分享语": "",
        "网盘": {"链接": "", "码": ""},
        "book_id": "",
        "文案": {"A": empty_copy(), "B": empty_copy()},
        "商品描述": "",
    }


def _clean_title(raw: str) -> str:
    """去反引号、去尾部括号注释、去粗体星号。"""
    s = raw.strip()
    s = s.replace("**", "")
    s = re.sub(r"`([^`]*)`", r"\1", s)
    # 去掉尾部的中英文括号注释（如「（17 字：年份+年级）」）
    s = re.sub(r"[（(][^（()）]*[)）]\s*$", "", s)
    return s.strip(" 　·-")


def _code_blocks(text: str) -> list[str]:
    return [m.group(1).rstrip() for m in RE_CODE.finditer(text)]


def _sections(text: str) -> list[tuple[str, str]]:
    """切成 (标题行, 正文块) 列表；首段无标题时标题为空串。"""
    marks = list(RE_H2.finditer(text))
    if not marks:
        return [("", text)]
    out: list[tuple[str, str]] = []
    if marks[0].start() > 0:
        out.append(("", text[: marks[0].start()]))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out.append((m.group(0).strip(), text[m.end() : end]))
    return out


def _pan_from(block: str) -> dict:
    """从一段文本抽网盘链接与提取码。"""
    link = ""
    pwd = ""
    m = RE_PAN.search(block)
    if m:
        link = m.group(0)
        q = RE_PWD_Q.search(link)
        if q:
            pwd = q.group(1)
    if not pwd:
        t = RE_PWD_T.search(block)
        if t:
            pwd = t.group(1)
    return {"链接": link, "码": pwd}


def _topics_from(block: str) -> list[str]:
    """抽话题词：优先「话题…：a · b · c」行，其次 #标签。"""
    m = RE_TOPIC.search(block)
    if m:
        raw = m.group(1)
        raw = raw.replace("**", "").replace("`", "")
        parts = re.split(r"[·•、,，\s]+", raw)
        out = [p.strip() for p in parts if p.strip() and not p.startswith("#")]
        if out:
            return out
    tags = RE_HASHTAG.findall(block)
    return [t.strip() for t in tags if t.strip()]


def _longest_paragraph(body: str, min_len: int = 60) -> str:
    """老册容错：商品描述没写成代码块时，取本节最长的一段正文（排除引用/表格/标题）。"""
    best = ""
    for para in re.split(r"\n\s*\n", body):
        lines = [
            ln
            for ln in para.strip().splitlines()
            if ln.strip() and not ln.lstrip().startswith((">", "|", "#", "-", "*"))
        ]
        if not lines:
            continue
        text = " ".join(" ".join(lines).split())
        if len(text) > len(best):
            best = text
    return best if len(best) >= min_len else ""


def _copy_from_section(body: str) -> dict:
    """从 A 版 / B 版小节抽 标题 + 正文 + 话题。"""
    item = empty_copy()
    m = RE_TITLE.search(body)
    if m:
        item["标题"] = _clean_title(m.group(1))
    for blk in _code_blocks(body):
        if "百度网盘" in blk:
            continue
        item["正文"] = blk.strip()
        break
    item["话题"] = _topics_from(body)
    return item


def _fallback_single(sections: list[tuple[str, str]]) -> dict:
    """老册容错：没有 A/B 分段时，用「## 标题 / ## 正文 / ## 标签」拼一份 A 版。

    （规格外的补充：老册若走「## 小红书文案」单节 或 标题/正文/标签 三小节格式，
    也把内容捞出来给页面用；完全捞不到就返回空。）
    """
    for head, body in sections:
        if "文案" in head:
            item = _copy_from_section(body)
            if item["标题"] or item["正文"]:
                return item
    item = empty_copy()
    for head, body in sections:
        h = head.replace("#", "").strip()
        if h.startswith("标题") and not item["标题"]:
            line = body.strip().splitlines()
            if line:
                item["标题"] = _clean_title(line[0])
        elif h.startswith("正文") and not item["正文"]:
            blocks = [b for b in _code_blocks(body) if "百度网盘" not in b]
            item["正文"] = (blocks[0] if blocks else body).strip()
        elif ("标签" in h or "话题" in h) and not item["话题"]:
            item["话题"] = _topics_from(body)
    return item


def parse_material(path: Path) -> dict:
    """解析一份发布物料 md。任何异常都吞掉，返回尽量填满的结构。"""
    res = empty_result()
    try:
        res["文件"] = str(path)
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return res
    try:
        # ① 网盘分享语 = 含「百度网盘」的代码块
        for blk in _code_blocks(text):
            if "百度网盘" in blk or "pan.baidu.com" in blk:
                res["分享语"] = blk.strip()
                res["网盘"] = _pan_from(blk)
                break
        if not res["网盘"]["链接"]:
            res["网盘"] = _pan_from(text)

        # ④ book_id = 第一个雪花号
        m = RE_BOOKID.search(text)
        if m:
            res["book_id"] = m.group(0)

        # ② A/B 文案分段 + ③ 商品上架描述
        sections = _sections(text)
        got_ab = False
        for head, body in sections:
            flat = head.replace(" ", "")
            if "A版" in flat:
                res["文案"]["A"] = _copy_from_section(body)
                got_ab = True
            elif "B版" in flat:
                res["文案"]["B"] = _copy_from_section(body)
                got_ab = True
            if "商品上架描述" in flat and not res["商品描述"]:
                blocks = _code_blocks(body)
                if blocks:
                    res["商品描述"] = " ".join(blocks[0].split())
                else:
                    res["商品描述"] = _longest_paragraph(body)
        if not got_ab:
            res["文案"]["A"] = _fallback_single(sections)
    except Exception:
        # 解析出岔子也返回半成品，不让页面挂掉
        return res
    return res


# ---------------------------------------------------------------- 目录扫描


def find_material_files(bdir: Path) -> list[Path]:
    """册目录下的 _交付/发布物料*.md（老册也可能直接在册根）。"""
    out: list[Path] = []
    deliver = bdir / "_交付"
    if deliver.is_dir():
        out.extend(sorted(deliver.glob("发布物料*.md")))
    if not out:
        out.extend(sorted(bdir.glob("发布物料*.md")))
    # 排除并档前的旧档（文件名带 _旧）
    return [p for p in out if not p.name.startswith("_旧")]


def version_key_of(md_path: Path) -> str:
    """按物料文件名判版本 key：发布物料-基础版.md → 基础版；否则「正册」。"""
    stem = md_path.stem
    for key in ("基础版", "提高版", "教辅版", "快速训练", "普及版", "进阶版"):
        if key in stem:
            return key
    m = re.match(r"发布物料[-_·]+(.+)$", stem)
    if m:
        return m.group(1).strip()
    return "正册"


def _role_of_dir(dir_name: str) -> str:
    """小红书图目录归 A/B：-A 结尾归 A，-B 结尾归 B；老册「小红书图-A浅水印」按首字母归。"""
    rest = dir_name.replace("小红书图", "").strip(" -_·")
    if rest.endswith("A"):
        return "A"
    if rest.endswith("B"):
        return "B"
    if rest.startswith("A"):
        return "A"
    if rest.startswith("B"):
        return "B"
    return ""


def find_image_dirs(bdir: Path, version_key: str) -> dict:
    """找该版本的小红书图目录，返回相对册目录的路径 {A:..., B:...}。"""
    out = {"A": "", "B": ""}
    roots = [bdir / "_交付", bdir]
    cands: list[Path] = []
    for r in roots:
        if r.is_dir():
            cands.extend([p for p in sorted(r.iterdir()) if p.is_dir() and "小红书图" in p.name])
        if cands:
            break
    if not cands:
        return out
    # 多版本册：优先取名字带版本 key 的目录
    if version_key and version_key != "正册":
        hit = [p for p in cands if version_key in p.name]
        if hit:
            cands = hit
        elif any(
            k in p.name for p in cands for k in ("基础版", "提高版", "教辅版", "快速训练")
        ):
            # 明确属于别的版本，本版本没有图
            return out
    for p in cands:
        role = _role_of_dir(p.name)
        if role and not out[role]:
            out[role] = p.relative_to(bdir).as_posix()
    return out
