"""语意轴 sidecar:bge-small-zh-v1.5 本地向量化。

三种用法:
    python embed.py --download           只下模型(ModelScope),不动库
    python embed.py --all [--force]      给 question 表全量算向量,写 BLOB 列「向量」
    python embed.py --query "买东西找零"  输出该文本的向量 JSON(给 Next API 调)

铁律:
- 模型一律走 ModelScope 下载(本机 HuggingFace 大文件经代理会被掐)。
- 向量 = float32 小端 BLOB,已 L2 归一化 => 余弦相似度 = 点积。
- 所有输出 UTF-8、无 emoji(GBK 控制台会杀进程)。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
MODEL_DIR = HERE / "models"
# ModelScope 上 bge-small-zh-v1.5 的候选仓库 id(按顺序试)
MODEL_IDS = ["AI-ModelScope/bge-small-zh-v1.5", "BAAI/bge-small-zh-v1.5"]
LOCAL_NAME = "bge-small-zh-v1.5"

DEFAULT_DB = r"D:\workplace\ai-bkb\举一反三产物\资料库.db"


def db_path() -> str:
    return os.environ.get("PUNCH_DB") or DEFAULT_DB


def model_path() -> Path:
    """已下好的本地模型目录;没有返回不存在的路径。

    ModelScope 的 cache 布局会嵌好几层(models/<owner>--<name>/snapshots/master),
    版本之间还会变,所以直接在 models/ 下递归找带 config.json 的目录。
    """
    p = MODEL_DIR / LOCAL_NAME
    if (p / "config.json").is_file():
        return p
    if MODEL_DIR.is_dir():
        for cfg in sorted(MODEL_DIR.rglob("config.json")):
            if (cfg.parent / "modules.json").is_file() or (
                cfg.parent / "model.safetensors"
            ).is_file():
                return cfg.parent
    return p


def download() -> Path:
    """从 ModelScope 拉模型,返回本地目录。"""
    from modelscope import snapshot_download

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    last = None
    for mid in MODEL_IDS:
        try:
            print(f"[download] try {mid}")
            got = snapshot_download(mid, cache_dir=str(MODEL_DIR))
            print(f"[download] ok -> {got}")
            return Path(got)
        except Exception as exc:  # noqa: BLE001 - 换下一个候选 id
            last = exc
            print(f"[download] fail {mid}: {exc}")
    raise RuntimeError(f"所有候选模型 id 都下载失败: {last}")


_MODEL = None


def load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    from sentence_transformers import SentenceTransformer

    p = model_path()
    if not (p / "config.json").is_file():
        p = download()
    # 断网也能跑:只读本地目录
    _MODEL = SentenceTransformer(str(p), device="cpu")
    return _MODEL


def encode(texts: list[str]):
    import numpy as np

    model = load_model()
    vec = model.encode(
        texts,
        batch_size=64,
        normalize_embeddings=True,  # 归一化后余弦 = 点积
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    return np.asarray(vec, dtype="float32")


def cmd_query(text: str) -> None:
    vec = encode([text])[0]
    print(json.dumps({"ok": True, "dim": int(vec.shape[0]), "vec": [float(x) for x in vec]}))


def cmd_serve() -> None:
    """常驻模式:stdin 一行一个 JSON {"text": "..."},stdout 一行一个结果。

    为什么要它:torch + 模型冷加载要十几秒,每次查询都 spawn 一个新进程的话
    页面就没法用了。常驻着只付一次加载钱,之后每问一次几十毫秒。
    """
    load_model()
    print(json.dumps({"ok": True, "ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text") or ""
            vec = encode([text])[0]
            out = {"ok": True, "id": req.get("id"), "vec": [float(x) for x in vec]}
        except Exception as exc:  # noqa: BLE001 - 单条失败不拖垮常驻进程
            out = {"ok": False, "error": str(exc)}
        print(json.dumps(out), flush=True)


def cmd_all(force: bool) -> None:
    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    sql = "SELECT id, stem FROM question"
    if not force:
        sql += " WHERE 向量 IS NULL"
    rows = con.execute(sql).fetchall()
    print(f"[all] 待算 {len(rows)} 题 (force={force})")
    if not rows:
        con.close()
        return
    step = 256
    done = 0
    for i in range(0, len(rows), step):
        chunk = rows[i : i + step]
        vecs = encode([(r["stem"] or "") for r in chunk])
        con.executemany(
            "UPDATE question SET 向量 = ? WHERE id = ?",
            [(memoryview(v.tobytes()), r["id"]) for r, v in zip(chunk, vecs)],
        )
        con.commit()
        done += len(chunk)
        print(f"[all] {done}/{len(rows)}")
    con.close()
    print(f"[all] 完成 {done} 题, dim={vecs.shape[1]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="bge-small-zh-v1.5 本地向量 sidecar")
    ap.add_argument("--download", action="store_true", help="只下载模型")
    ap.add_argument("--all", action="store_true", help="全量算向量写库")
    ap.add_argument("--force", action="store_true", help="配合 --all:已有向量也重算")
    ap.add_argument("--query", type=str, default=None, help="算单条文本向量并输出 JSON")
    ap.add_argument("--serve", action="store_true", help="常驻:stdin JSON 行进,stdout JSON 行出")
    args = ap.parse_args()

    if args.download:
        download()
        return
    if args.serve:
        cmd_serve()
        return
    if args.query is not None:
        cmd_query(args.query)
        return
    if args.all:
        cmd_all(args.force)
        return
    ap.print_help()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - 给调用方一个可解析的失败信号
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
