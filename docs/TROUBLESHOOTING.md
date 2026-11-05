# 故障处理

先运行 `node tools/setup/doctor.mjs`，只检查配置名和文件 readiness。不要把完整环境、Secret 或私有报告贴进公开 issue。保留安全错误码、来源 revision 和不含凭据的运行链接。

| 现象 | 排查与处理 |
| --- | --- |
| 初始 workflow 没有自动运行 | 模板默认未启用调度；先完成本人配置、Secrets、首次手动验收，再按工作流说明启用 |
| `blocked_auth`、GC 登录失败 | 检查当前私有仓库 `STEAM_REFRESH_TOKEN` 是否存在、是否属于 `STEAMID64`；过期后在本人终端重新扫码并安全更新 Secret，手动 retry；不打印令牌 |
| Steam 扫码脚本拒绝输出路径 | 文件已存在时不会覆盖；使用新的私有路径或在确认无用后由本人删除旧文件 |
| Steam 其他设备游戏会话冲突 | 等本人游戏结束再试，不关闭其游戏，不抢占会话 |
| 没发现旧比赛 | GC 窗口有限；核对分享代码 API 三项配置、官方历史和原始下载有效性，不承诺恢复全部历史 |
| `unavailable` / HTTP 404 | 链接暂不可用或过期，保留队列和退避记录；不把任务改成成功、不高频无限重试 |
| 自定义 Demo URL 被拒绝 | 使用精确可信 HTTPS 域名，在允许名单中同时覆盖重定向；不要允许任意域名 |
| Actions 不能保存结果 | 检查仓库/组织工作流写权限，默认分支 `main` 和当前安装仓库归属；不要使用作者的 token |
| Leetify 返回 401/403 | 检查本人 key 和隐私配置；这是补充统计服务，与 GC 登录分开 |
| Dashboard 仍是空白 | 检查是否实际生成分片、是否导入 R2、最终 index_commit 是否完成、身份是否一致；空 bootstrap 不是导入成功 |
| `sync_snapshot_not_configured` | Sites 自己的 secret `GITHUB_ACTIONS_TOKEN` 未应用，或仓库配置未生成；Codex 环境中的同名变量不等同生产配置 |
| GitHub 读取 403/404 | 细粒度 token 是否选中了当前私有数据仓库，Contents read/Actions 权限是否批准；不要通过公开仓库绕过 |
| shard / digest / revision mismatch | 固定完整同一个 commit，核对字节和 SHA，再按全部详情→全部统计→索引上传；不要跳过校验或覆盖不可变对象 |
| 地图底图不显示 | 模板不附未获许可图像；核对自己的合法素材和 sources 清单。无地图时不能伪造加载成功 |
| 原生回放尚未渲染 | 选择视角轨迹；要真实画面时再在本人的机器按需捕获，不用生成动画替代 |
| MCP 插件工具没出现 | 确认自己的 Site 带 `mcp` capability 已发布，连接 Sites 生成的私有插件；必要时新开聊天，工具名前缀以实际发现为准 |
| MCP 401/403 | 在本人 ChatGPT/Sites 会话重新登录并检查站点访问授权，不伪造身份头，不放宽私有访问 |
| 网站内置教练未配置 | 没有 DeepSeek key 时属预期；MCP 仍可由 ChatGPT 模型分析。需要网站教练时再配置并应用 secret |
| 模型请求失败 | 区分 key 权限、余额、提供方限流、模型名称与网络故障；保存任务进度后修复再续办，不用连续重复付费请求掩盖问题 |
| 本地测试访问生产服务 | 去掉子进程中的托管凭证、模型 key 和生产数据 root，使用合成夹具；不要清空用户的永久环境配置 |

## 最小重现与验收

离线检查：`python -m unittest discover -s tests -v`、`npm test --prefix steam`、`node --test tools/setup/*.test.mjs`。运行前隔离生产凭据。

需要确认解析器时，优先用 CI 固定的公开 Demo 在独立临时 root 验证；不要写进本人 `data/`、`reports/`。公开样本的 URL、版本和 SHA 以当前检查工作流为准，不从私人缓存拷贝。

修复后重试同一任务，核对旧成功记录保留、新结果的来源和身份正确。一个 HTTP health、通过构建或绿色 Actions 不代表下载、解析、导入、MCP 与网页交互全部验收完成。
