# Yero 移动端生图工作区

Yero 是移动优先的生图界面，支持文字和参考图创作、模板、浅色与深色主题、分辨率选择、聊天记录和图片收藏。发送按钮旁的麦克风可将录音转成文字并回填输入框；生图等待期间显示轻量动画。任务结果返回发起会话；服务接受提交后清空对应输入，提交失败时保留输入。

## 安装、构建与测试

需要 Node.js 22 或更新版本。克隆仓库后，在仓库根目录运行：

```sh
npm ci
npm run build
npm test
```

构建入口是 `build.mjs`，静态页面为 `dist/site/index.html`，同目录的 `_worker.js` 是 Cloudflare Pages 的服务端代码。字体字符集与图像素材已包含在源码中；如果修改界面并新增字体字符，构建脚本可能需要访问 Google Fonts 更新子集。

本机生图和语音转录程序需要 Python 3 及以下依赖：

```sh
python -m pip install -r requirements.txt
python -m unittest test_yero_relay test_yero_runner test_yero_voice -v
```

`npm test` 使用模拟服务，不会向线上发送生图请求。可选的 `test_cloud_session.mjs` 和 `test_cloud_reference.mjs` 会发起真实任务，必须显式设置 `YERO_TEST_ACCESS_CODE_FILE`；参考图测试还需 `YERO_BRIDGE_JOBS_DIR`。可通过 `YERO_TEST_BASE_URL` 指定测试站点。不要在仓库内存放访问码文件。

## 接口与部署

前端通过同源的 `POST /api/jobs` 创建生图任务、通过 `POST /api/transcriptions` 创建转录任务，并通过 `GET /api/jobs/<任务ID>` 查询结果；请求使用用户提供的访问码。Cloudflare Pages 的 `_worker.js` 提供这些接口与相互独立的后台队列。纯静态托管或将界面接到其他站点时，必须为相同路径提供兼容的服务端接口或受保护的同源转发；仅发布静态页面不会让生图和语音自动可用，也不应把后台凭据放进前端。

Cloudflare 部署需要以下**名称**，具体值应通过平台的密钥管理单独配置：

- `YERO_ACCESS_CODE`：供网页用户连接生图服务的访问码。
- `YERO_RUNNER_KEY`：本机后台程序与云端队列通信使用的密钥。
- `YERO_STORAGE_KEY`：加密队列内容所需的 64 位十六进制密钥。
- `YERO_QUEUE`：Cloudflare KV 绑定名称，属于资源绑定而不是密钥。
- `YERO_DISPATCH`：指向独立 `WakeHub` Durable Object 的服务绑定，用于按任务通知本机执行端。

`cloud/wrangler.example.toml` 只包含占位值。实际的 `cloud/wrangler.toml`、`.env`、访问码、队列密钥、本机桥接配置和用户数据均不应提交到仓库。

通知协调器的源码和示例配置分别位于 `cloud/wake.mjs` 和 `cloud/wake.wrangler.example.toml`。发布前需核实 Cloudflare 的用量、剩余额度及账单状态；先准备协调器及 Pages 绑定，再在没有运行中任务时协调更新 Pages 和两个本机执行端。旧队列中的任务不会自动迁入新通知器，切换前必须先完成或单次核对旧任务；保留本机待上传结果和历史数据。空闲时执行端保持通知连接，不轮询 KV；连接保活和实际任务仍会产生网络与 Cloudflare 用量。

后台程序 `yero_runner.py` 使用现有 ImageGen 桥接，调用时通过 `--secret-dir` 指定受限目录，通过 `--bridge-config` 指定本机桥接配置，通过 `--url` 指定 HTTPS 服务地址；其目录中的 `relay-key.txt`、`storage-key.txt` 以及桥接配置中的 `api_key` 必须留在本机。`yero_relay.py` 提供仅限生图的适配能力，不需要修改原桥接。运行生图依赖本机桥接在线且后台程序持续运行。

2K 和 4K 使用本机 Upscayl 轻量模型进行超分，默认目录为 `D:\CodexData\YeroImageTest-20261029\upscayl`，可通过环境变量 `YERO_UPSCAYL_DIR` 指定包含程序及 `models` 文件夹的目录。程序使用小分块与单任务处理；模型按 4 倍超分并调整到选定尺寸，2K、4K 并非原生生成。缺少程序或模型时会在发起生图前报错，超分失败不会伪装成成功。原生 `2K Ultra`、`4K Ultra` 为待配置选项，在接入真实 API 前无法提交。

参考图最大 17 MiB；图片和选区编码后的请求合计最大 24 MiB，以便保留 4K 图片继续局部编辑，同时不超过 KV 单值限制。

涂抹用于提示需要修改的大致位置，由模型结合指令判断完整目标；模型会重新生成整幅画面，选区外也可能变化。输出会恢复为原图尺寸，但模型生成尺寸可能较小，并非原生 4K。

若生图桥提示未取得生成文件路径，Yero 只在本机记录能唯一对应当前涂抹任务、文件有效且比例正确时恢复结果；无法确认时仍返回失败，不会借用其他任务的图片。

语音由独立的 `yero_voice.py --secret-dir <受限目录>` 拉取并在本机使用 `faster-whisper` 的 `base` 模型转录，不占用生图队列。模型需事先缓存在本机；程序不会自动下载。当前电脑已准备该模型，转录需要这台电脑和语音后台程序在线。录音最长 55 秒、最大 2 MiB。录音在云端加密暂存，处理完后从队列移除；若处理未完成，队列录音最多保留 10 分钟。识别文字只回填原会话的输入框，不会自动发送。

## 数据与使用边界

聊天消息、结果和收藏保存在当前浏览器；清除浏览器数据、更换设备或使用隐私模式可能导致记录不可用。未发送的草稿仅在当前页面切换时保留，刷新后不会自动恢复，刷新也不能自动续接正在生成的任务。参考图编辑保留模型生成图的原始比例；1K 按长边等比缩放，2K 和 4K 为超分结果，不等同于原生高清生成。

模板需要用户上传图片。用户可在手机上长按生成图保存，也可使用页面的保存按钮。建议在真实手机上检查键盘、安全区和长按行为。

当前 Cloudflare 地址：<https://yero-mobile-studio.pages.dev/>。
