# 第三方组件与素材

项目源码的授权以仓库根目录 `LICENSE` 为准。下列第三方组件和游戏素材保留各自许可；本项目的源码许可不改变它们的权利归属。

## 运行依赖

| 组件 | 上游与用途 |
| --- | --- |
| demoparser2 | <https://github.com/LaihoE/demoparser>，CS2 Demo 解析，版本固定在 `requirements-demo.txt` |
| node-steam-user | <https://github.com/DoctorMcKay/node-steam-user>，Steam 客户端会话 |
| node-steam-session | <https://github.com/DoctorMcKay/node-steam-session>，本人手机扫码登录 |
| node-globaloffensive | <https://github.com/DoctorMcKay/node-globaloffensive>，CS 游戏协调器查询 |
| csgo-sharecode | <https://www.npmjs.com/package/csgo-sharecode>，分享代码编码解码 |
| qrcode-terminal | <https://github.com/gtanner/qrcode-terminal>，终端二维码 |
| @netlify/blobs | <https://github.com/netlify/blobs>，可选托管适配依赖；使用 Sites 不意味着需要 Netlify 部署 |

安装 lockfile 依赖时，保留 npm/Python 包附带的 LICENSE/NOTICE。以上是来源导航，不是把上游软件改授为本项目许可。升级依赖或再分发 vendored 代码时，需检查实际版本的许可及通告要求。

## 地图雷达图像

Counter-Strike 2 地图、雷达图像、名称和游戏资源属于其各自权利人（包括 Valve）。AWPy/AWPy-data 的提取或打包工具采用的源码许可，不自动将游戏图像改授为同一许可。

模板不默认附带雷达 PNG 或其他未确认可公开再分发的游戏素材。用户可按本人使用条件自行取得素材，保留来源、版本、校验和与权利归属；需要公开传播时自行确认许可。AWPy-data 上游：<https://github.com/pnxenopoulos/awpy-data>。模板可保存坐标转换说明和来源元数据，不代表对地图版本与历史 Demo 完全一致作保证。

## 本机捕获工具

HLAE、FFmpeg、Steam 和 CS2 由用户按其各自许可安装。模板只提供捕获适配源码与版本/验证流程，不分发游戏文件、现成个人捕获媒体、登录信息或第三方可执行程序。

- HLAE：<https://github.com/advancedfx/advancedfx>
- FFmpeg：<https://ffmpeg.org/legal.html>
- Steam / CS2：适用用户所接受的 Valve 条款。

## 模型与 Agent 设计参考

DeepSeek API 是可选外部服务，使用者自行持有账户与 key，并承担其费用和服务条款。网站与 MCP 不代表 DeepSeek、Valve 或第三方背书。

若当前版本参考或移植 DeepSeek Harness 的具体代码，应在相应源码与设计文档保留所用版本、上游链接、MIT 版权与许可全文；仅参考公开架构也应注明设计来源。上游：<https://github.com/deepseek-ai/deepseek-harness>。不可把未审核的第三方插件直接安装到可读取私人数据的运行环境。
