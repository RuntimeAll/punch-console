# 打卡产线控制台（punch-console）

手机能开的一张「打卡册产线台」：一册一张产线卡，看得见每册走到哪一步、文案一键复制、图一键存、销量随手记。

🔴 **本地工具，不进系统**（CLAUDE.md §0.0 本地先行、上线后置）。无数据库、无前端构建，**文件系统即事实源**。

## 一分钟跑起来

```powershell
cd D:\workplace\ai-bkb\codeplace-O\punch-console
uv venv .venv
uv pip install -p .venv nicegui pymupdf requests

.venv\Scripts\python.exe bootstrap.py     # 铺底：给每册生成 产线卡.json（幂等）
.venv\Scripts\python.exe app.py           # 起服务 → http://<本机IP>:8787
```

手机与电脑同一个 WiFi，浏览器开 `http://<电脑内网IP>:8787` 即可（服务 host=0.0.0.0，端口 8787）。

## 常驻（当前机器已配好，重装才需要重做）

- **开机自启** = 启动文件夹快捷方式 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\punch-console.lnk`，
  指向 [serve.ps1](serve.ps1)（端口已被占则不重复起；日志落 `service.log` / `service.err`）。
  schtasks / 服务注册在本机都要提权，启动文件夹**免提权**，够用。
- **手动拉起 / 重启**：直接跑 `powershell -File serve.ps1`；要强制重启先按端口杀
  `netstat -ano | findstr :8787` 找 PID → `taskkill /F /PID <pid>`（🔴 别按进程名杀 python，会误伤别的服务）。
- **防火墙**（手机连不上九成是它）：入站放行 8787，需管理员跑一次：
  `netsh advfirewall firewall add rule name="punch-console 8787" dir=in action=allow protocol=TCP localport=8787`
  （删除 = 同名 `delete rule`；本机已加）。

## 数据在哪

| 东西 | 位置 |
|---|---|
| 数据根 `PUNCH_ROOT` | `D:\workplace\ai-bkb\举一反三产物\打卡`（可用环境变量 `PUNCH_ROOT` 覆盖） |
| 产线卡 | `<册目录>/产线卡.json`（每册一张，UTF-8） |
| 发布物料 | `<册目录>/_交付/发布物料*.md`（**文案正本仍是它**，控制台只读不改） |
| 小红书图 | `<册目录>/_交付/小红书图-*`（A/B 双骨架） |
| 成品 PDF | `<册目录>/成品PDF/<版本>/` 或册根 `*.pdf` |
| 下单队列 | `<数据根>/_队列/待办|完成/<时间戳>-<册名>.json` |

🔴 **控制台写的只有三样**：产线卡.json（销量 / 三步走 / 状态）、队列单据。**绝不改 md、绝不动 PDF。**

## 三个页面

| 页 | 路径 | 干什么 |
|---|---|---|
| 看板 | `/` | 总销量 + 在售册数；科目/年级筛选；册卡片（三步走圆点 + 累计销量）；**汇总PDF**（勾多册合并下载）；进队列下单 |
| 册详情 | `/book/<册名>` | 版本 tab：网盘分享语 → 小红书 A/B 文案 → 商品描述（各带复制）→ 图墙（缩略图/点开原图/打包 zip）→ 成品 PDF 下载 → 销量记账 → 三步走开关 |
| 队列下单 | `/queue` | 填册名/版本/考点/天数/备注 → 写一张待办单（自带 `model=opus`、`skill=每日打卡`）；下方看待办与完成 |

## 产线卡 schema

```jsonc
{
  "name": "三升四每日一练",      // = 目录名
  "科目": "数学",
  "年级": "三升四",
  "绑定": { "类型": "考点", "值": [] },   // 类型 = 考点 | 年级
  "状态": "在售",                          // 在产 | 可发布 | 在售 | 停售
  "版本": [                                // 单版本册也走数组，key = "正册"
    {
      "key": "基础版",
      "book_id": "2083060307883036673",   // 线上打卡书 id，字符串（雪花号绝不当数字）
      "网盘": { "链接": "https://pan.baidu.com/s/...", "码": "eawp" },
      "三步走": { "打样": "done", "全册": "done", "物料": "done", "录prod": "done" },
      "物料文件": "_交付/发布物料-基础版.md",
      "图目录": { "A": "_交付/小红书图-基础版-A", "B": "_交付/小红书图-基础版-B" },
      "销量": [ { "日期": "2026-08-07", "件数": 2, "渠道": "小红书A号" } ]
    }
  ]
}
```

## 铺底脚本

```powershell
.venv\Scripts\python.exe bootstrap.py            # 只补没有卡的册（幂等，跑几次结果一样）
.venv\Scripts\python.exe bootstrap.py --force    # 全部重算重写（会覆盖手填的绑定/状态，慎用）
.venv\Scripts\python.exe bootstrap.py --dry-run  # 只打印不写盘
```

判定规则：每个 `发布物料*.md` = 一个版本（文件名含「基础版/提高版」取作 key，否则 `正册`）；
有成品 PDF ⇒ 打样/全册 done；有物料 md ⇒ 物料 done；抽到 book_id ⇒ 录prod done；有网盘链接 ⇒ 状态置「在售」。

## 已知边界

- **老册物料 md 格式不统一**（并档前的 `## 标题 / ## 正文` 版、`## 二、小红书文案` 版都在）。
  解析层尽力抽，抽不到就留空——**不报错、不猜**。要文案完整，把该册 md 改成现行格式（三升四那份是模板）。
- 复制按钮在 HTTP 局域网下走 `document.execCommand` 兜底（`navigator.clipboard` 只在 HTTPS/localhost 可用）；
  再失败会提示「长按文本框全选复制」。
- 图墙直接引用数据根静态目录，**不复制、不缩图**；册子图多时首屏会慢一点。
