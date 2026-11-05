# CS2 Analyst · Agent-Ready Template

把这个模板交给具备代码执行能力的 Agent，为自己搭建独立的 CS2 比赛数据系统：自动发现官匹、下载 Demo、逐回合解析、私有网页仪表盘，以及供 ChatGPT 使用的 MCP 数据工具。

**不配置 DeepSeek API，也能使用 Demo 自动化、网页数据视图和 MCP。** ChatGPT 使用自己的模型调用网站工具；网站内置 DeepSeek 教练是可选功能。

## 开始使用

1. 在 GitHub 点击 **Use this template → Create a new repository**，为自己的比赛数据选择 **Private** 仓库。模板是公开代码，不含任何人的比赛数据、Steam 会话或已注册站点。
2. 把下面提示词和新仓库链接交给自己的 Agent：

   > 阅读 AGENTS.md 和 docs/AGENT_SETUP.md，为我搭建使用本人 CS2 数据的独立系统。先做离线检查，再协助安全设置 Steam / GitHub / Sites。任何密钥不要发到聊天、日志或 Git。先跑通比赛下载分析和 MCP；DeepSeek 暂不配置。不要操作模板作者或其他人的资源。最后分别报告已验证、尚未验证及需要我完成的账号授权。

3. 按 [Agent 安装指南](docs/AGENT_SETUP.md) 完成本人账号接入。不能让 Agent 替你批准 Steam 扫码或猜测凭证。

## 功能

| 部分 | 用途 | 是否需要模型 API |
| --- | --- | --- |
| Steam GC / 分享代码 | 发现本人比赛并获取可用 Demo 链接 | 否 |
| Python 解析 | 回合、伤害、玩家、轨迹、射击与道具事件；私有分片与报告 | 否 |
| GitHub Actions | 手动同步及配置后的定时运行 | 否 |
| Dashboard | 总览、对局、玩家、战术回放、瞄准实验室、数据中心 | 否 |
| Sites MCP | 让 ChatGPT 查询本人数据、引用证据，按需下钻 | 否；由聊天中的模型分析 |
| 网站内置教练 | 多轮任务、数据工具、图表与训练建议 | 可选 DeepSeek API |
| 原生回放 | 在本人 Windows / Steam / CS2 上按需捕获、上传 | 否；另需合法游戏与捕获工具 |

初始同步与发布处于未配置状态。完成配置检查和首次成功同步后，再启用自己仓库的自动调度。新站点保持私有，不能为方便 MCP 连接而公开个人数据。

## 文档

- [分阶段 Agent 安装与验收](docs/AGENT_SETUP.md)
- [配置、账号与 Secrets](docs/CONFIGURATION.md)
- [系统架构与数据流](docs/ARCHITECTURE.md)
- [指标口径与证据边界](docs/METRICS.md)
- [故障处理](docs/TROUBLESHOOTING.md)
- [第三方组件和素材说明](THIRD_PARTY_NOTICES.md)

模板不会承诺取回所有历史 Demo：Steam GC 窗口有限，旧下载可能已失效。缺失和失败数据不会自动变成零表现。原生片段只有经过真实捕获和证据校验才标记已渲染。
