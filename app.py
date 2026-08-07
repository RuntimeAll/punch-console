"""打卡产线控制台（NiceGUI）。

手机浏览器优先：看板 / 册详情 / 队列下单三页。
文件系统即事实源，所有写操作直接落 <册>/产线卡.json。
启动：python app.py  → http://<本机IP>:8787
"""
from __future__ import annotations

import json
import urllib.parse
import zipfile
from datetime import date
from pathlib import Path

from nicegui import app as ng_app
from nicegui import ui

import data
import materials
import pdfops

PORT = 8787
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# 静态挂载：数据根 → /data，图片用 /data/<册>/<相对路径> 引用
if data.PUNCH_ROOT.is_dir():
    ng_app.add_static_files("/data", str(data.PUNCH_ROOT))


# ---------------------------------------------------------------- 通用件


def data_url(book: str, rel: str) -> str:
    """拼静态资源 URL（中文路径做百分号编码）。"""
    parts = [book] + [p for p in str(rel).replace("\\", "/").split("/") if p]
    return "/data/" + "/".join(urllib.parse.quote(p) for p in parts)


def download_file(path: Path, name: str | None = None) -> None:
    """兼容新旧 NiceGUI 的下载调用。"""
    dl = getattr(ui, "download", None)
    fn = getattr(dl, "file", None)
    if callable(fn):
        fn(path, name or path.name)
    else:  # 老版本 ui.download 直接可调用
        dl(path, name or path.name)  # type: ignore[misc]


def copy_button(text: str, label: str = "复制", icon: str = "content_copy") -> None:
    """复制按钮。HTTP 局域网下 navigator.clipboard 被禁，必须带 execCommand 兜底。"""
    payload = json.dumps(text or "")

    async def do_copy() -> None:
        js = (
            "(async () => {"
            f"  const t = {payload};"
            "  try { await navigator.clipboard.writeText(t); return 'ok'; }"
            "  catch (e) {"
            "    try {"
            "      const ta = document.createElement('textarea');"
            "      ta.value = t; ta.style.position = 'fixed'; ta.style.left = '-9999px';"
            "      document.body.appendChild(ta); ta.focus(); ta.select();"
            "      const ok = document.execCommand('copy');"
            "      document.body.removeChild(ta);"
            "      return ok ? 'ok' : 'fail';"
            "    } catch (e2) { return 'fail'; }"
            "  }"
            "})()"
        )
        try:
            res = await ui.run_javascript(js, timeout=5.0)
        except Exception:
            res = "fail"
        if res == "ok":
            ui.notify("已复制", type="positive", position="top")
        else:
            ui.notify("复制失败：请长按文本框全选复制", type="warning", position="top")

    ui.button(label, icon=icon, on_click=do_copy).props("dense flat color=primary")


def header(title: str, back: bool = False) -> None:
    with ui.header().classes("items-center justify-between px-3 py-2 bg-primary text-white"):
        with ui.row().classes("items-center gap-2"):
            if back:
                ui.button(icon="arrow_back", on_click=lambda: ui.navigate.to("/")).props(
                    "flat round dense color=white"
                )
            ui.label(title).classes("text-lg font-bold")
        with ui.row().classes("items-center gap-1"):
            ui.button(icon="dashboard", on_click=lambda: ui.navigate.to("/")).props(
                "flat round dense color=white"
            )
            ui.button(icon="playlist_add", on_click=lambda: ui.navigate.to("/queue")).props(
                "flat round dense color=white"
            )


def step_dots(version: dict) -> None:
    """三步走四个小圆点。"""
    with ui.row().classes("gap-1 items-center"):
        for s in data.STEPS:
            done = version["三步走"].get(s) == "done"
            doing = version["三步走"].get(s) == "doing"
            color = "green" if done else ("orange" if doing else "grey-4")
            ui.icon("circle", size="10px").classes(f"text-{color}")
        ui.label(version["key"]).classes("text-xs text-grey-7")


# ---------------------------------------------------------------- 页1 看板


@ui.page("/")
def page_board() -> None:
    ui.page_title("打卡产线控制台")
    header("打卡产线台")
    cards = data.list_cards()

    total_sales = sum(data.card_sales(c) for c in cards)
    on_sale = sum(1 for c in cards if c["状态"] == "在售")

    with ui.column().classes("w-full max-w-3xl mx-auto p-3 gap-3"):
        with ui.row().classes("w-full gap-2"):
            for label, val, color in (
                ("累计销量(件)", total_sales, "text-primary"),
                ("在售册数", on_sale, "text-teal"),
                ("总册数", len(cards), "text-grey-8"),
            ):
                with ui.card().classes("flex-1 items-center py-2"):
                    ui.label(str(val)).classes(f"text-2xl font-bold {color}")
                    ui.label(label).classes("text-xs text-grey-7")

        subjects = ["全部"] + sorted({c["科目"] for c in cards if c["科目"]})
        grades = ["全部"] + sorted({c["年级"] for c in cards if c["年级"]})
        with ui.row().classes("w-full gap-2 items-center"):
            sel_sub = ui.select(subjects, value="全部", label="科目").classes("flex-1")
            sel_grade = ui.select(grades, value="全部", label="年级").classes("flex-1")
        with ui.row().classes("w-full gap-2"):
            ui.button("汇总PDF", icon="picture_as_pdf", on_click=lambda: merge_dialog(cards)).props(
                "outline dense"
            ).classes("flex-1")
            ui.button(
                "队列下单", icon="playlist_add", on_click=lambda: ui.navigate.to("/queue")
            ).props("outline dense").classes("flex-1")

        listing = ui.column().classes("w-full gap-2")

        def render() -> None:
            listing.clear()
            with listing:
                shown = [
                    c
                    for c in cards
                    if (sel_sub.value in ("全部", None) or c["科目"] == sel_sub.value)
                    and (sel_grade.value in ("全部", None) or c["年级"] == sel_grade.value)
                ]
                if not shown:
                    ui.label("没有符合条件的册").classes("text-grey-6 p-4")
                for c in shown:
                    book_card(c)

        sel_sub.on_value_change(lambda _: render())
        sel_grade.on_value_change(lambda _: render())
        render()


def book_card(card: dict) -> None:
    name = card["name"]
    with ui.card().classes("w-full cursor-pointer").on(
        "click", lambda n=name: ui.navigate.to(f"/book/{urllib.parse.quote(n)}")
    ):
        with ui.row().classes("w-full items-center justify-between no-wrap"):
            ui.label(name).classes("text-base font-bold")
            ui.badge(card["状态"]).props(
                "color=" + {"在售": "green", "可发布": "orange", "停售": "grey", "在产": "blue"}[card["状态"]]
            )
        with ui.row().classes("items-center gap-2 text-xs text-grey-7"):
            ui.label(card["科目"] or "-")
            ui.label(card["年级"] or "年级未定")
            bind = card["绑定"]
            if bind.get("值"):
                ui.label("%s：%s" % (bind.get("类型", "考点"), "、".join(bind["值"][:3])))
        with ui.column().classes("gap-1 w-full"):
            for v in card["版本"]:
                with ui.row().classes("items-center gap-3 w-full"):
                    step_dots(v)
                    ui.space()
                    ui.label("售 %d 件" % data.version_sales(v)).classes("text-xs text-grey-7")


def merge_dialog(cards: list[dict]) -> None:
    """勾选多册 → 合并成品 PDF → 下载。"""
    with ui.dialog() as dlg, ui.card().classes("w-full max-w-lg"):
        ui.label("汇总 PDF").classes("text-lg font-bold")
        ui.label("勾选要合并的册（按题目卷/全部成品顺序拼接）").classes("text-xs text-grey-7")
        picks: dict[str, ui.checkbox] = {}
        only_q = ui.checkbox("只要题目卷（文件名不含「答案/解析」）", value=True)
        with ui.scroll_area().classes("w-full h-64"):
            for c in cards:
                n = c["name"]
                cnt = sum(len(data.find_pdfs(n, v["key"])) for v in c["版本"])
                if cnt == 0:
                    continue
                picks[n] = ui.checkbox("%s（%d 份）" % (n, cnt))

        def do_merge() -> None:
            chosen = [n for n, cb in picks.items() if cb.value]
            if not chosen:
                ui.notify("先勾几册", type="warning")
                return
            paths: list[Path] = []
            for n in chosen:
                card = next(c for c in cards if c["name"] == n)
                for v in card["版本"]:
                    for rel in data.find_pdfs(n, v["key"]):
                        if only_q.value and any(k in rel.name for k in ("答案", "解析")):
                            continue
                        paths.append(data.book_dir(n) / rel)
            if not paths:
                ui.notify("勾选的册里没找到 PDF", type="warning")
                return
            out = pdfops.merge_to_temp(paths, "打卡汇总-%s.pdf" % date.today().isoformat())
            ui.notify("已合并 %d 份，开始下载" % len(paths), type="positive")
            download_file(out)
            dlg.close()

        with ui.row().classes("w-full justify-end gap-2"):
            ui.button("取消", on_click=dlg.close).props("flat")
            ui.button("合并下载", on_click=do_merge).props("color=primary")
    dlg.open()


# ---------------------------------------------------------------- 页2 册详情


@ui.page("/book/{name}")
def page_book(name: str) -> None:
    name = urllib.parse.unquote(name)
    ui.page_title(name)
    header(name, back=True)
    card = data.load_card(name)
    if card is None:
        with ui.column().classes("p-4 gap-2"):
            ui.label("这册还没有产线卡").classes("text-lg")
            ui.label("先跑 bootstrap.py 铺底").classes("text-grey-7")
        return

    with ui.column().classes("w-full max-w-3xl mx-auto p-3 gap-3"):
        with ui.row().classes("items-center gap-2 w-full"):
            ui.label(card["科目"] or "-").classes("text-sm")
            ui.label(card["年级"] or "年级未定").classes("text-sm")
            ui.space()
            status = ui.select(data.STATUSES, value=card["状态"], label="状态").classes("w-32")

            def save_status() -> None:
                card["状态"] = status.value
                data.save_card(card)
                ui.notify("状态已保存：%s" % status.value, type="positive")

            status.on_value_change(lambda _: save_status())

        with ui.tabs().classes("w-full") as tabs:
            for v in card["版本"]:
                ui.tab(v["key"])
        with ui.tab_panels(tabs, value=card["版本"][0]["key"]).classes("w-full"):
            for v in card["版本"]:
                with ui.tab_panel(v["key"]).classes("p-0"):
                    version_panel(card, v)


def version_panel(card: dict, version: dict) -> None:
    name = card["name"]
    bdir = data.book_dir(name)
    md_rel = version.get("物料文件") or ""
    parsed = materials.empty_result()
    if md_rel and (bdir / md_rel).is_file():
        parsed = materials.parse_material(bdir / md_rel)

    with ui.column().classes("w-full gap-3 pt-2"):
        # (a) 网盘分享语
        share = parsed["分享语"]
        if not share and version["网盘"]["链接"]:
            share = "链接：%s\n提取码：%s" % (version["网盘"]["链接"], version["网盘"]["码"])
        with ui.card().classes("w-full"):
            with ui.row().classes("w-full items-center justify-between"):
                ui.label("网盘分享语").classes("font-bold")
                copy_button(share)
            ui.textarea(value=share or "（未抽到网盘分享语）").props("outlined autogrow readonly").classes(
                "w-full text-sm"
            )
            if version.get("book_id"):
                ui.label("book_id：%s" % version["book_id"]).classes("text-xs text-grey-7")

        # (b) 小红书文案 A / B
        for role in ("A", "B"):
            item = parsed["文案"][role]
            if not (item["标题"] or item["正文"]):
                continue
            with ui.card().classes("w-full"):
                with ui.row().classes("w-full items-center justify-between"):
                    ui.label("小红书文案 · %s 版" % role).classes("font-bold")
                    # 复制内容 = 标题换行正文，话题词不进剪贴板
                    copy_button("%s\n%s" % (item["标题"], item["正文"]))
                ui.label(item["标题"] or "（无标题）").classes("text-sm font-medium")
                ui.textarea(value=item["正文"]).props("outlined autogrow readonly").classes(
                    "w-full text-sm"
                )
                if item["话题"]:
                    ui.label("话题（手动挂，不进剪贴板）：" + " · ".join(item["话题"])).classes(
                        "text-xs text-grey-7"
                    )

        # (c) 商品上架描述
        if parsed["商品描述"]:
            with ui.card().classes("w-full"):
                with ui.row().classes("w-full items-center justify-between"):
                    ui.label("商品上架描述").classes("font-bold")
                    copy_button(parsed["商品描述"])
                ui.textarea(value=parsed["商品描述"]).props("outlined autogrow readonly").classes(
                    "w-full text-sm"
                )

        # (d) 图墙
        img_wall(name, version)

        # (e) 成品 PDF
        pdfs = data.find_pdfs(name, version["key"])
        with ui.card().classes("w-full"):
            ui.label("成品 PDF（%d 份）" % len(pdfs)).classes("font-bold")
            if not pdfs:
                ui.label("没找到成品 PDF").classes("text-xs text-grey-6")
            with ui.column().classes("gap-0 w-full"):
                for rel in pdfs:
                    ui.link(rel.name, data_url(name, rel)).classes("text-sm").props(
                        'target=_blank download'
                    )

        # (f) 销量
        sales_block(card, version)

        # (g) 三步走
        steps_block(card, version)


def img_wall(name: str, version: dict) -> None:
    bdir = data.book_dir(name)
    dirs = version.get("图目录") or {}
    if not (dirs.get("A") or dirs.get("B")):
        return
    with ui.card().classes("w-full"):
        ui.label("小红书图（A/B 双骨架）").classes("font-bold")
        for role in ("A", "B"):
            rel = dirs.get(role) or ""
            if not rel:
                continue
            d = bdir / rel
            if not d.is_dir():
                continue
            imgs = sorted(p for p in d.iterdir() if p.suffix.lower() in IMG_EXT)
            with ui.row().classes("w-full items-center gap-2"):
                ui.label("%s 骨架 · %d 张" % (role, len(imgs))).classes("text-sm")
                ui.space()
                ui.button(
                    "打包zip",
                    icon="folder_zip",
                    on_click=lambda n=name, r=rel: zip_dir(n, r),
                ).props("dense flat color=primary")
            with ui.row().classes("w-full flex-nowrap overflow-x-auto gap-2 pb-1"):
                for p in imgs:
                    url = data_url(name, Path(rel) / p.name)
                    with ui.link(target=url, new_tab=True):
                        ui.image(url).classes("w-24 h-32 object-cover rounded border")


def zip_dir(name: str, rel: str) -> None:
    """把图目录动态打成 zip 下载。"""
    import tempfile

    src = data.book_dir(name) / rel
    if not src.is_dir():
        ui.notify("目录不存在", type="warning")
        return
    tmp = Path(tempfile.mkdtemp(prefix="punch-zip-"))
    out = tmp / ("%s-%s.zip" % (name, Path(rel).name))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(src).as_posix())
    ui.notify("已打包，开始下载", type="positive")
    download_file(out)


def sales_block(card: dict, version: dict) -> None:
    name = card["name"]
    with ui.card().classes("w-full"):
        with ui.row().classes("w-full items-center justify-between"):
            ui.label("销量").classes("font-bold")
            total = ui.label("累计 %d 件" % data.version_sales(version)).classes("text-sm text-primary")
        rows = ui.column().classes("w-full gap-0")

        def render_rows() -> None:
            rows.clear()
            with rows:
                items = version.get("销量") or []
                if not items:
                    ui.label("还没有销量记录").classes("text-xs text-grey-6")
                for r in reversed(items):
                    with ui.row().classes("w-full items-center justify-between text-sm"):
                        ui.label(str(r.get("日期", "")))
                        ui.label(str(r.get("渠道", ""))).classes("text-grey-7")
                        ui.label("%s 件" % r.get("件数", 0)).classes("font-medium")

        render_rows()
        with ui.row().classes("w-full items-end gap-2"):
            d_in = ui.input("日期", value=date.today().isoformat()).classes("flex-1")
            q_in = ui.number("件数", value=1, min=1, precision=0).classes("w-20")
            c_in = ui.select(data.CHANNELS, value=data.CHANNELS[0], label="渠道").classes("flex-1")

            def submit() -> None:
                try:
                    qty = int(q_in.value or 0)
                except (TypeError, ValueError):
                    qty = 0
                if qty <= 0:
                    ui.notify("件数要大于 0", type="warning")
                    return
                version.setdefault("销量", []).append(
                    {"日期": d_in.value or date.today().isoformat(), "件数": qty, "渠道": c_in.value}
                )
                data.save_card(card)
                total.text = "累计 %d 件" % data.version_sales(version)
                render_rows()
                ui.notify("已记 %d 件" % qty, type="positive")

            ui.button("记一笔", icon="add", on_click=submit).props("color=primary dense")


def steps_block(card: dict, version: dict) -> None:
    with ui.card().classes("w-full"):
        ui.label("三步走").classes("font-bold")
        with ui.row().classes("w-full flex-wrap gap-3"):
            for step in data.STEPS:
                sw = ui.switch(step, value=version["三步走"].get(step) == "done")

                def on_change(e, s=step) -> None:
                    version["三步走"][s] = "done" if e.value else "todo"
                    data.save_card(card)
                    ui.notify("%s → %s" % (s, version["三步走"][s]), position="top")

                sw.on_value_change(on_change)


# ---------------------------------------------------------------- 页3 队列下单


@ui.page("/queue")
def page_queue() -> None:
    ui.page_title("队列下单")
    header("队列下单", back=True)
    cards = data.list_cards()
    names = [c["name"] for c in cards]

    with ui.column().classes("w-full max-w-3xl mx-auto p-3 gap-3"):
        with ui.card().classes("w-full"):
            ui.label("新下一单").classes("font-bold")
            book_sel = ui.select(names, label="册名", with_input=True).classes("w-full")
            ver_sel = ui.select([], label="版本").classes("w-full")

            def sync_versions() -> None:
                c = next((x for x in cards if x["name"] == book_sel.value), None)
                keys = [v["key"] for v in c["版本"]] if c else []
                ver_sel.options = keys
                ver_sel.value = keys[0] if keys else None
                ver_sel.update()

            book_sel.on_value_change(lambda _: sync_versions())
            kp_in = ui.input("绑定考点（逗号分隔）").classes("w-full")
            days_in = ui.number("天数", value=10, min=1, precision=0).classes("w-full")
            note_in = ui.textarea("备注").props("outlined autogrow").classes("w-full")

            def submit() -> None:
                if not book_sel.value:
                    ui.notify("先选册", type="warning")
                    return
                payload = {
                    "册名": book_sel.value,
                    "版本": ver_sel.value or "正册",
                    "绑定考点": [
                        s.strip()
                        for s in str(kp_in.value or "").replace("，", ",").split(",")
                        if s.strip()
                    ],
                    "天数": int(days_in.value or 0),
                    "备注": note_in.value or "",
                }
                p = data.create_order(payload)
                ui.notify("已下单：%s" % p.name, type="positive")
                ui.navigate.to("/queue")

            ui.button("下单", icon="send", on_click=submit).props("color=primary").classes("w-full")

        for title, sub in (("待办", data.QUEUE_TODO), ("完成", data.QUEUE_DONE)):
            rows = data.list_queue(sub)
            with ui.card().classes("w-full"):
                ui.label("%s（%d）" % (title, len(rows))).classes("font-bold")
                if not rows:
                    ui.label("空").classes("text-xs text-grey-6")
                for r in rows:
                    with ui.column().classes("w-full gap-0 border-b py-1"):
                        ui.label("%s · %s · %s 天" % (r.get("册名", "?"), r.get("版本", "-"), r.get("天数", "-"))).classes(
                            "text-sm font-medium"
                        )
                        detail = "考点：%s" % "、".join(r.get("绑定考点") or []) if r.get("绑定考点") else ""
                        if r.get("备注"):
                            detail = (detail + "　" if detail else "") + r["备注"]
                        if detail:
                            ui.label(detail).classes("text-xs text-grey-7")
                        ui.label(r.get("_文件", "")).classes("text-xs text-grey-5")


if __name__ in {"__main__", "__mp_main__"}:
    ui.run(host="0.0.0.0", port=PORT, title="打卡产线控制台", reload=False, show=False)
