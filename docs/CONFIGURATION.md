# 配置、账号与 Secrets

每份安装只绑定一个 SteamID64。配置文件中的仓库和站点 ID 是路由参数；令牌与 API key 是秘密，两者应分开管理。

## 本地配置

使用 `node tools/setup/configure.mjs --repository OWNER/PRIVATE_REPO --steamid YOUR_STEAMID64 --display-name "My CS2"`，站点注册后增加 `--site-origin` 和 `--sites-project-id`。运行 `node tools/setup/doctor.mjs` 检查当前配置和文件，不打印秘密。

`.env.example` 仅说明环境变量，程序不会自动读取它。需要本地运行时由本人安全工具注入进程环境，不提交填好的 `.env`。不要将 Secrets 写进 `dashboard/ui/`、构建产物、仓库变量或 URL。

## GitHub Actions Secrets

在自己的 **Private** 数据仓库：Settings → Secrets and variables → Actions → New repository secret。

| Secret | 必要性与来源 |
| --- | --- |
| `STEAMID64` | 必填，本人 17 位 SteamID64；与所有解析结果核对 |
| `STEAM_REFRESH_TOKEN` | 使用 Steam GC 发现与解析下载链接所需；`steam/login.mjs` 手机扫码生成，安全 stdin 导入 |
| `LEETIFY_API_KEY` | 可选，在本人 Leetify Developer 获取；丰富个人战绩，不负责 Demo 登录 |
| `STEAM_WEB_API_KEY` | 推荐的分享代码连续发现路径，与下面两项一起设置；本人 Steam API key |
| `STEAM_MATCH_AUTH_CODE` | 本人 CS2 比赛历史访问码；不是 Steam Guard 验证码或密码 |
| `STEAM_KNOWNCODE` | 本人的近期官匹分享代码 `CSGO-…`，作为后续发现游标 |

`STEAM_WEB_API_KEY`、`STEAM_MATCH_AUTH_CODE`、`STEAM_KNOWNCODE` 未配置时不能宣称官方历史覆盖完整。GC 自身能发现有限的最近比赛窗口；历史 Demo 可能已经过期。纯手动 `demo_url` 能绕过 GC 链接解析，但仍需本人 SteamID 核验，不能当作稳定自动发现方案。

工作流 `GITHUB_TOKEN` 是 GitHub 自动提供的任务令牌，用于当前仓库保存进度，不需要复制为长效 Secret。仓库/组织策略必须允许工作流声明的 Contents write 权限。

仓库 Variable `CS2_SYNC_ENABLED` 默认为未设置；配置完成后设为字符串 `true` 才允许运行同步 job。初始模板只有 `workflow_dispatch`，不包含自动 push 或 cron 触发；先手动验收，再按 [安装指南](AGENT_SETUP.md) 添加本人需要的 schedule。

另一个可选 Variable 是 `CS2_DEMO_ALLOWED_HOSTS`：仅列精确、受信任的额外 HTTPS 域名，用逗号分隔；默认 Valve replay 域名无需添加。不要设置通配符或为了通过测试允许任意 URL。

## Sites 安全运行环境

| 项目 | 用途 |
| --- | --- |
| 私有 project ID / site origin | 当前用户注册时返回的配置；不沿用他人 ID |
| R2 binding `BUCKET` | 私有持久化数据、Agent 会话与媒体；不是公开 static 目录 |
| `GITHUB_ACTIONS_TOKEN`，secret | 当前用户的细粒度 token，仅限数据仓库；Contents read、Actions read/write，用于读取快照、调度与观察同步 |
| `DEEPSEEK_API_KEY`，secret | 可选网站内置教练；不影响 Demo 工作流或 MCP |
| MCP capability | `dashboard/.openai/hosting.json` 保留 `"mcp"`，发布时由 Sites 生成私有插件 |

GitHub Actions Secrets、Codex 环境秘密、Sites 运行环境是三套独立配置。只在一处设置不代表另外两处已经可用。修改后使用托管平台支持的应用环境流程，检查名字和 readiness，不回显值。

不要要求自己把 GitHub token、DeepSeek key、Steam refresh token 交给聊天。不要将代理引用占位值当真实 API key 转发。朋友的 Agent 也无需作者的密钥。

## 访问与共享

公开模板只含可分发代码；每个人的生成数据仓库和站点仍是私有。Sites 会校验访问者和 MCP 调用者，再将请求转发给应用。不要用放宽站点访问、浏览器暴露密钥或自造身份头解决插件登录故障。

若选择其他托管平台，应单独实现等价访问控制、持久存储与 MCP 认证。直接把 Worker 静态文件上传到公开 CDN 不能获得这些能力，不能声称与 Sites 私有部署等价。
