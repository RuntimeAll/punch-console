import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { WORKSPACE_ROOT } from "@/db/paths";

export const runtime = "nodejs";

/** 只允许打开工作区内的路径——服务端执行 explorer,越界即拒。 */
function 在工作区内(p: string) {
  const rel = path.relative(WORKSPACE_ROOT, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 打开资源管理器定位文件/文件夹。
 * mode=reveal(默认) 打开所在文件夹并选中;mode=open 用默认程序打开本体。
 * 🔴 只在服务端所在的这台机器上弹窗——手机点了,窗口开在电脑上。
 */
export async function POST(req: Request) {
  let 路径 = "";
  let mode = "reveal";
  try {
    const body = await req.json();
    路径 = String(body?.路径 ?? "");
    if (body?.mode === "open") mode = "open";
  } catch {
    return Response.json({ ok: false, err: "请求体不是 JSON" }, { status: 400 });
  }

  if (!路径 || 路径.includes("\0")) {
    return Response.json({ ok: false, err: "路径为空" }, { status: 400 });
  }

  const abs = path.resolve(路径);
  if (!在工作区内(abs)) {
    return Response.json({ ok: false, err: "路径不在工作区内,拒绝打开" }, { status: 403 });
  }
  if (!existsSync(abs)) {
    return Response.json({ ok: false, err: "文件已不在这个位置(可能被移动或重命名)" }, { status: 404 });
  }

  // 目录本身没有"所在文件夹"可选中,直接打开它
  const 是目录 = statSync(abs).isDirectory();
  const args = mode === "open" || 是目录 ? [abs] : [`/select,${abs}`];

  // 🔴 不走 shell(参数数组直传,路径含空格/中文都安全);
  //    explorer.exe 成功时也常返回退出码 1,所以不看退出码。
  spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).unref();

  return Response.json({ ok: true, 已打开: abs, mode: 是目录 ? "folder" : mode });
}
