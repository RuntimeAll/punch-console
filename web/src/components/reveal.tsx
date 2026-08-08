"use client";

import { useState } from "react";

type Mode = "reveal" | "open";

async function 打开(路径: string, mode: Mode) {
  const r = await fetch("/api/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ 路径, mode }),
  });
  const j = await r.json().catch(() => ({ ok: false, err: "服务没响应" }));
  if (!j.ok) throw new Error(j.err || "打开失败");
}

/**
 * 在资源管理器里定位文件/文件夹。
 * 🔴 窗口开在**跑服务的那台电脑**上——手机点了,是电脑上弹出来。
 */
export function Reveal({
  路径,
  mode = "reveal",
  className,
  children,
  title,
}: {
  路径: string;
  mode?: Mode;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  return (
    <button
      type="button"
      title={title ?? (mode === "open" ? "用默认程序打开" : "在文件夹中显示")}
      className={className}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setErr("");
        try {
          await 打开(路径, mode);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        } catch (x) {
          setErr(x instanceof Error ? x.message : "打开失败");
          setTimeout(() => setErr(""), 4000);
        }
      }}
    >
      {children}
      {ok && <span className="ml-1 text-emerald-600">已在电脑上打开</span>}
      {err && <span className="ml-1 text-red-600">{err}</span>}
    </button>
  );
}
