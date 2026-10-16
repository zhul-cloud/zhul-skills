# 08 · 采购

发给用户、在他们自己电脑上运行的 AI 技能，配合 zhul-trade-erp 的「我的询价」使用，但不属于 ERP 程序。由维护者管理和发放。

| 技能 | 版本 | 用途 |
|---|---|---|
| [烛龙AI询价](烛龙AI询价/SKILL.md) | 1.4.0 | AI 自动询价：读取 ERP 询价任务 → 在淘宝、1688 同时找店询价 → 在任务页面填报价并提交回价（一次一个任务） |

使用方法、询价规则、生成的文件及位置见 [烛龙AI询价/使用手册.md](烛龙AI询价/使用手册.md)；版本变化见 [烛龙AI询价/CHANGELOG.md](烛龙AI询价/CHANGELOG.md)；已讨论但还没实施的功能见 [ROADMAP.md](ROADMAP.md)。

## 用户电脑需要准备

1. **Claude Code 或 Codex**（任选其一，已登录）。两者都通过 npm 安装，装好后电脑上就有 Node.js，技能里的脚本不需要再装其他东西。
2. **BrowserOS neo**，并把它的 MCP 连接到 Claude Code 或 Codex（在 BrowserOS neo 的 MCP 连接页面一键连接）。
3. 在 BrowserOS neo 里登录：公司 ERP（AI 使用的采购账号）、淘宝买家账号、1688 买家账号。AI 只使用已有的登录状态，不输入密码。

## 发放与安装

把整个 `烛龙AI询价` 文件夹拷给用户，放到：

| 使用的 AI | Windows | macOS / Linux |
|---|---|---|
| Claude Code | `C:\Users\<用户名>\.claude\skills\烛龙AI询价\` | `~/.claude/skills/烛龙AI询价/` |
| Codex | `C:\Users\<用户名>\.codex\skills\烛龙AI询价\` | `~/.codex/skills/烛龙AI询价/` |

两个都用就各放一份。macOS 的访达默认隐藏以 `.` 开头的文件夹，按 `Cmd + Shift + .` 显示，或在访达「前往文件夹」（`Cmd + Shift + G`）里输入上面的路径。新开一个会话后，对 AI 说「帮我询价 IQxxxx」即可。AI 每次运行时会把技能自带的站点脚本（`helpers/`）装进 BrowserOS neo，已是最新的跳过。

**用 install.sh 安装**（维护者自己的电脑，或已克隆本仓库的用户电脑）：仓库根目录的 `install.sh` 会把本库**所有**技能（含烛龙AI询价）以软链接装进 `~/.claude/skills/`，`git pull` 后自动生效。它只装 Claude Code，不装 Codex；用户只需要询价技能时，按上表单独拷文件夹即可。Windows 上在 Git Bash 里运行时，没开「开发者模式」的话 `ln -s` 会变成复制，`git pull` 后要重新运行一次。

**升级**：用新版文件夹整个替换旧的。询价记录、本机经验和实跑报告存在数据目录（Windows `C:\Users\<用户名>\.zhul-trade-sourcing\`，macOS/Linux `~/.zhul-trade-sourcing/`），不在技能文件夹里，替换不会丢。

## 修改规则

技能的所有内容（包括 `settings.json`）都由维护者测试、调优后统一定版发放，用户不在自己电脑上改。

| 要改什么 | 改哪个文件 |
|---|---|
| 发询价前是否确认、询价店铺数、等待时间、轮询间隔、追问次数、防重复天数、价格异常标准、道谢说法 | `烛龙AI询价/settings.json`（详细说明见 `烛龙AI询价/references/settings.md`） |
| 流程、红线 | `烛龙AI询价/SKILL.md` |
| 挑店标准、话术、回复判断、货况货期对照 | `烛龙AI询价/references/inquiry-rules.md` |
| 各平台页面操作、机器人标记、结束信号 | `烛龙AI询价/platforms/<平台>.md`（目前有 `taobao.md`、`1688.md`；新平台的说明文件经实跑验证后放进来，该平台即启用） |
| 站点脚本 | `烛龙AI询价/helpers/<域名>/<脚本名>.md`（BrowserOS neo 站点脚本格式） |

改了上表任何一个文件，都要同步更新 `烛龙AI询价/使用手册.md`，让手册和技能内容保持一致。

文档只写当前方案，读起来是一份完整的说明：改规则时直接替换旧内容，不保留旧方案的说法，也不写「某次实跑」「自某版起」这类历史说明。改了什么写进 `CHANGELOG.md`。

### 版本号

改完按下面的规则升级版本号，同时修改 `SKILL.md` 开头的 `version`、上表的版本号和使用手册开头的「适用版本」，在 `CHANGELOG.md` 最上面加一条，再重新发放。技能每次运行时会先输出版本号，用户反馈问题时请附上这行，方便判断是哪一版。

| 改动 | 版本号 | 例 |
|---|---|---|
| 修正文字、补充说明，询价行为不变 | 修订号 +1 | 1.2.0 → 1.2.1 |
| 规则或流程变化（话术、挑店、税率、等待时间等） | 次版本号 +1 | 1.2.1 → 1.3.0 |
| 流程整体改写，旧版不再适用 | 主版本号 +1 | 1.x → 2.0.0 |

## 收集各用户电脑上的经验

技能运行后，会把新发现的页面事实写进用户电脑数据目录下的 `learnings/`，新做的站点脚本存在 BrowserOS neo 的站点脚本目录：

| 系统 | 站点脚本目录 |
|---|---|
| Windows（已实测） | `%LOCALAPPDATA%\BrowserClaw\User Data\.browseros\.browserclaw\helpers\` |
| macOS（推定，未实测） | `~/Library/Application Support/BrowserClaw/.browseros/.browserclaw/helpers/` |
| Linux（推定，未实测） | `~/.config/BrowserClaw/.browseros/.browserclaw/helpers/` |

macOS、Linux 的目录是按 Chromium 的惯例推定的。如果 `records.mjs install-helpers` 报找不到目录，就在该电脑上找到实际目录，用环境变量 `BROWSEROS_HELPERS_DIR` 指定，再把实际路径更新到本表和 `records.mjs`。维护者定期收集，把通用的合进技能（页面事实进 `platforms/`，脚本进 `helpers/`），升级版本后发放，再删掉经验文件里已合并的条目。

维护者还可以在用户电脑上运行 `records.mjs stats` 统计各结束原因和店家提问的类型、占比，据此决定是否扩大答复店家的范围，见使用手册 7.1。

每次运行结束，技能还会在数据目录下的 `reports/` 写一份实跑报告（`<YYYY-MM-DD>-<任务编号>.md`，含结果、各阶段耗时、问题、红线执行情况、建议），只存本机，用来分析效率和排查问题。报告里有店铺名和采购价，属于公司内部数据，收集时不要放进本仓库（本仓库公开）。
