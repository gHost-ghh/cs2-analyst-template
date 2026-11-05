# 给 Agent 的安装与验收指南

目标是建立使用当前用户身份、仓库、站点和存储的独立系统。先跑通 Demo 自动分析与 MCP；DeepSeek 是可选增强。

## 1. 审核与本地检查

读取 `AGENTS.md`，检查工作区和 Git remote。确认目标数据仓库为 **Private**。不要 Fork 后公开任何含个人数据的历史仓库，也不要从其他人的工作目录复制环境文件。

需要 Python 3.12、Node.js 22 或以上、Git。GitHub CLI 仅用于有授权的 Secret 导入或仓库操作。解析依赖固定在 `requirements-demo.txt`，Steam 依赖固定在 lockfile。

```bash
python -m pip install -r requirements-demo.txt
npm ci --prefix steam --ignore-scripts
npm ci --prefix dashboard --ignore-scripts
python -m unittest discover -s tests -v
npm test --prefix steam
node --test tools/setup/*.test.mjs
node tools/setup/doctor.mjs
```

离线测试不要继承 `NETLIFY_AUTH_TOKEN`、`NETLIFY_SITE_ID`、`CS2_REQUIRE_BLOB_STORAGE`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 或 `GITHUB_ACTIONS_TOKEN`。不要为了让本地测试通过而调用生产存储或模型。未配置站点时，doctor 的待配置项属于安装进度，不代表第三方服务故障。

## 2. 绑定本人安装

先向用户确认新的私有仓库和 SteamID64（17 位数字）。这些是身份配置，不是 Steam 密码。命令不需要秘密：

```bash
node tools/setup/configure.mjs --repository OWNER/PRIVATE_REPO --steamid YOUR_STEAMID64 --display-name "My CS2"
node tools/setup/doctor.mjs
```

configure 用于生成当前安装配置和空白 Dashboard。不要将已含其他 Steam 身份的数据仓库改成新账号；应新建独立安装。`dashboard/data/dashboard.json` 是构建引导数据，不能用模板作者的真实快照替代。

## 3. 安全设置 Actions Secrets

按 [配置清单](CONFIGURATION.md) 在当前私有仓库设置 Secrets。`STEAMID64` 必填；使用 Steam GC 发现及下载时还需 `STEAM_REFRESH_TOKEN`。Leetify 和 Steam Web API 的补充凭据不是 GC 登录的替代品。

Steam refresh token 通过一次性扫码生成。在本人控制的本机终端或 Codespace 中运行：

```bash
npm ci --prefix steam --ignore-scripts
node steam/login.mjs --output .private/steam-refresh-token
```

用户用 Steam 手机 App 扫码，核对设备和地点后批准。代码只将令牌写入指定的全新文件，不输出令牌；已有文件会被拒绝覆盖。不要 `cat` 文件、复制到聊天、截图或上传日志。不要在无人值守 Actions 日志里扫码。

有当前仓库 Secret 写权限的 Bash 终端可直接导入并删除临时文件：

```bash
gh secret set STEAM_REFRESH_TOKEN --repo OWNER/PRIVATE_REPO < .private/steam-refresh-token
rm -f .private/steam-refresh-token
```

PowerShell 可使用标准输入管线，内容直接交给 `gh`，不要保存为变量或打印：

```powershell
Get-Content -Raw -LiteralPath .private/steam-refresh-token | gh secret set STEAM_REFRESH_TOKEN --repo OWNER/PRIVATE_REPO
if ($LASTEXITCODE -eq 0) { Remove-Item -LiteralPath .private/steam-refresh-token }
```

成功导入后删除未使用的登录文件，检查 `.private/` 和令牌路径被忽略。Windows 上 POSIX 文件模式不等同于 NTFS ACL；令牌文件必须留在仅本人可访问的目录。

## 4. 首次真实比赛同步

将经审核代码置于当前仓库默认分支 `main`。本人配置和 Secrets 完成后，在仓库 **Settings → Secrets and variables → Actions → Variables** 设置 `CS2_SYNC_ENABLED` 为字符串 `true`，允许同步 job 执行。模板初始只有手动入口，没有 `push` 或 `schedule` 触发器。

在 **Actions → CS2 match sync → Run workflow** 首次手动运行；可填本人 `share_code`，更新登录后可选择 `retry_now`。只使用获授权的 Demo URL；不要把账号凭据放在 workflow 输入里。

验收不只看工作流绿色状态。需逐项核对：

- `reports/demo_status.json` 存在本轮实际处理成功的任务，不能把 `waiting_for_replays` 当作下载成功。
- 已生成本人比赛数据、回合统计和 `reports/dashboard.index.json`。
- 所有者 SteamID64 与用户配置一致；有效回合数大于零。
- 详情与统计分片的路径、SHA 和索引引用一致；原始 Demo 和令牌没有进入 Git。
- 失败任务保留安全错误码、退避时间；已有成功分析不被覆盖。

确认完成后，经用户授权，在 `.github/workflows/sync.yml` 的 `on:` 下与 `workflow_dispatch:` 同级添加周期入口，例如每两小时：

```yaml
  schedule:
    - cron: '23 */2 * * *'
```

提交到 `main` 后启用。`CS2_SYNC_ENABLED=true` 仍需保留；设为其他值可暂停 job。GitHub cron 按 UTC，执行可能延迟；不要承诺精确到分钟。Steam 最近比赛窗口有限，不保证补齐全部历史。

## 5. 注册自己的私有 Sites

使用 Sites 插件为当前用户创建一个新的、私有站点。不要复用任何模板作者的 project ID、URL、凭证或 Git remote。新建成功后，把 **工具返回的原始** project ID 和站点 URL 传给配置器：

```bash
node tools/setup/configure.mjs --repository OWNER/PRIVATE_REPO --steamid YOUR_STEAMID64 --display-name "My CS2" --site-origin https://YOUR-SITE.chatgpt.site --sites-project-id RETURNED_PROJECT_ID
```

模板的 `dashboard/` 是完整前后端源码，`dashboard/.openai/hosting.json` 需保留独立项目 ID、`r2: "BUCKET"` 和 `capabilities: ["mcp"]`。R2 保存私有索引、分片、会话与上传媒体；不能只靠静态页面替代存储。

在此站点的安全运行环境设置 **secret** `GITHUB_ACTIONS_TOKEN`：用当前用户的细粒度 GitHub token，仅授权当前数据仓库，至少需要 Contents read 和 Actions read/write（读取数据与调度同步）。token 不需要原作者仓库权限。按托管平台流程应用运行环境，不把 Codex 云环境变量视为已部署秘密。

遵循当前已安装 Sites 技能：官方 source helper 打开/打包，经检查后推送精确源码，再保存并私有发布同一版本。不能使用模板中的空占位 project ID 假装部署成功。可先运行 `npm run build --prefix dashboard` 检查构建；若地图或原生助手未安装，相关功能应明确缺失，不能填入其他人的归档。

同步数据时从当前数据仓库的同一个完整 commit 获取紧凑索引和分片，依序上传详情、统计分片，再提交索引；或使用站点已实现的 GitHub 快照导入。核对来源 commit、content SHA、场数、回合数和生成时间，不能只比较版本号。

## 6. 在 ChatGPT 连接 MCP

Sites 发布带 `mcp` capability 的站点时，会为所有者创建或更新相应私有插件。使用 **该站点生成的插件**；不需要额外开一个公开 HTTP 服务，也不需要把 `OAI-Sites-Authorization` 或 GitHub token 贴进 ChatGPT。

如果当前聊天没有出现工具，让 Sites Agent 读 `get_site(include_mcp_connection: true)` 返回的插件 ID，并调用受支持的插件安装/连接入口。也可在 **Plugins → Personal → Created by you** 查找自己的站点插件。安装后可能需要新开聊天。

先调用 `read_dashboard_status` / `read_data_catalog`，再调用目录实际列出的查询工具。工具名字会由平台加前缀，使用实际发现的名字。提示词示例：

> 使用我的 CS2 插件先读数据目录和来源，比较全部已同步比赛中 T/CT 首死、零伤害阵亡、ADR 与补枪结构。优先调用确定性聚合；发现异常后再查询原始事件或采样，引用比赛/回合/来源。缺少可见性或输入证据时不要推断反应时间与按键原因。给出可复测训练计划。

MCP 验收需实际返回属于当前用户的数据和来源引用。未登录请求应被拒绝；不能通过公开站点或伪造身份头绕过认证。DeepSeek 留空时，以上仍应可用。

## 7. 可选网站教练与原生回放

希望使用网站内置 Agent 时，再在 Sites Secrets 设置 `DEEPSEEK_API_KEY`，按当前提供方接口确认 `deepseek-flash` 可用性，并用一个实际小任务验收多轮、工具调用、流式输出和保存恢复。API 服务商额度与上下文限制仍适用。没有 key 时显示未配置，不影响 MCP。

原生回放是独立可选阶段：在本人 Windows、Steam 和 CS2 环境安装按需助手，审查工具来源与许可，捕获前后验证设置完全恢复。不能安装常驻渲染服务、租用云 GPU，或把仅有视角轨迹标记成原生回放。没有游戏环境时明确列为未验收即可。

## 最终交付清单

报告私有仓库、私有站点、实际源码 revision；列出离线检查、一次真实 Demo、自动调度配置、MCP 实际查询、数据归属与页面交互的证据。单独标明可选 DeepSeek/原生回放状态和需要用户完成的登录。不得将空白部署与朋友账号的完整端到端验收混为一谈。
