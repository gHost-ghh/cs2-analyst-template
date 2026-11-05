# 架构与数据流

```text
本人的 Steam GC 最近比赛 / 官方分享代码 / 可选 Leetify
                    ↓
             持久化 Demo 任务队列
                    ↓
       下载 → 解压与 SHA 校验 → 受限 Python 解析子进程
                    ↓
      私有 GitHub 数据仓库：紧凑索引 + 详情/统计分片
                    ↓（固定同一个完整 commit）
      Sites 私有 R2：先分片上传验证，最后提交索引
               ↙                  ↘
     Dashboard 确定性视图         MCP 数据查询
               ↓                  ↓
    可选 DeepSeek 网站 Agent     ChatGPT 自己的模型
```

## 代码布局

| 路径 | 职责 |
| --- | --- |
| `sync.py` | Leetify 统计与官方分享代码发现 |
| `steam/` | 本人手机扫码 bootstrap、Steam GC 发现和链接解析 |
| `cs2demo/` | 下载、解析、指标、回放、玩家、分片与进度保存 |
| `tests/` | 解析和管线的可复用离线/合成验证 |
| `.github/workflows/` | 合成检查和配置后的本人同步工作流 |
| `dashboard/ui/` | 页面、图表、回放、内置 Agent 界面 |
| `dashboard/worker/` | 私有 API、MCP、导入、查询和可选模型编排 |
| `dashboard/shared/` | 受约束的交互文档与表达式 |
| `tools/setup/` | 个人化配置、doctor 和安装测试 |
| `tools/local-render/`、`tools/native-animation/` | 可选本机捕获与原设置事务 |

`data/`、`reports/` 初始为空；首次运行生成当前用户结果。Dashboard 引导数据与合成测试夹具不代表真实比赛。模板没有任何已注册个人部署、私有历史或模型凭证。

## 数据格式与所有者保护

`reports/dashboard.index.json` 保存小型汇总和每场引用；详情与统计各自存放为私有分片。`_cs2_storage` 元数据记录 source revision、字节数、内容 SHA 和所有者身份。上传顺序为 `match_upload` → `statistics_upload` → `index_commit`；不能先提交索引再慢慢填缺失分片。

Git commit SHA 用来固定读取的仓库状态；报告 source revision / content SHA 用来验证逻辑内容；部署源码 revision 用来说明运行代码。这三种版本不能混为一谈。数据同步不必重新部署网页代码。

升级或下载失败时，保留旧的成功结果和已有历史分析。失败任务记录错误类别及下次尝试时间，不覆盖已成功比赛，也不把缺失的伤害等字段改为零。

## Agent 与 MCP 的区别

MCP 是受认证的数据工具接口，本身不产生模型费用、不需要 DeepSeek key。ChatGPT 使用聊天中当前模型选择工具、解释查询结果。网站 Agent 则由可选 DeepSeek API 在服务器端执行多轮编排并生成交互图解，两条路径共享同一套数据口径与来源。

大规模问题先在 typed compute/bulk 工具中筛选、分组与聚合，模型只接收当前任务需要的精确结果。需要复查时再查询具体事件、帧或原始已存字段。工具不执行任意 shell、SQL 或用户脚本。采样数据不是完整原始 Demo；缺失的观测无法查询补出。

## 可选地图与原生媒体

雷达底图是第三方/游戏素材，许可与源码不同。模板不默认分发未获明确许可的地图图像；缺少底图时应保留无底图轨迹或显示资源未安装。用户自行取得、核对来源和校验值后再安装到本人的部署。不能将平面雷达当作视线遮挡证据。

本机原生捕获只在用户要求时启动本人的已安装游戏和工具，设置事务负责精确备份/恢复。工具源码可打包为自己的助手 ZIP；旧机器的 ZIP、缓存、Demo 或视频不能拷入模板。媒体必须经真实捕获、对齐与上传校验后才可被网站称为“原生回放”。
