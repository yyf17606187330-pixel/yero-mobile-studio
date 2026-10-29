# Yero 移动端生图工作区

Yero 是移动优先的生图界面，支持文字和参考图创作、模板、浅色与深色主题、分辨率选择、聊天记录和图片收藏。当前界面修复了生成期间切换会话造成的状态混淆：任务结果返回发起会话；服务接受提交后清空对应输入，提交失败时保留输入。

## 安装、构建与测试

需要 Node.js 22 或更新版本。克隆仓库后，在仓库根目录运行：

```sh
npm ci
npm run build
npm test
```

构建入口是 `build.mjs`，静态页面为 `dist/site/index.html`，同目录的 `_worker.js` 是 Cloudflare Pages 的服务端代码。字体字符集与图像素材已包含在源码中；如果修改界面并新增字体字符，构建脚本可能需要访问 Google Fonts 更新子集。

本机生图适配程序需要 Python 3、Pillow 和 cryptography：

```sh
python -m pip install -r requirements.txt
python -m unittest test_yero_relay test_yero_runner -v
```

`npm test` 使用模拟服务，不会向线上发送生图请求。可选的 `test_cloud_session.mjs` 和 `test_cloud_reference.mjs` 会发起真实任务，必须显式设置 `YERO_TEST_ACCESS_CODE_FILE`；参考图测试还需 `YERO_BRIDGE_JOBS_DIR`。可通过 `YERO_TEST_BASE_URL` 指定测试站点。不要在仓库内存放访问码文件。

## 接口与部署

前端通过同源的 `POST /api/jobs` 创建任务，并通过 `GET /api/jobs/<任务ID>` 查询结果；请求使用用户提供的访问码。Cloudflare Pages 的 `_worker.js` 提供这些接口与后台队列。纯静态托管或将界面接到其他站点时，必须为相同的 `/api/jobs` 路径提供兼容的服务端接口或受保护的同源转发；仅发布静态页面不会让生图自动可用，也不应把后台凭据放进前端。

Cloudflare 部署需要以下**名称**，具体值应通过平台的密钥管理单独配置：

- `YERO_ACCESS_CODE`：供网页用户连接生图服务的访问码。
- `YERO_RUNNER_KEY`：本机后台程序与云端队列通信使用的密钥。
- `YERO_STORAGE_KEY`：加密队列内容所需的 64 位十六进制密钥。
- `YERO_QUEUE`：Cloudflare KV 绑定名称，属于资源绑定而不是密钥。

`cloud/wrangler.example.toml` 只包含占位值。实际的 `cloud/wrangler.toml`、`.env`、访问码、队列密钥、本机桥接配置和用户数据均不应提交到仓库。

后台程序 `yero_runner.py` 使用现有 ImageGen 桥接，调用时通过 `--secret-dir` 指定受限目录，通过 `--bridge-config` 指定本机桥接配置，通过 `--url` 指定 HTTPS 服务地址；其目录中的 `relay-key.txt`、`storage-key.txt` 以及桥接配置中的 `api_key` 必须留在本机。`yero_relay.py` 提供仅限生图的适配能力，不需要修改原桥接。运行生图依赖本机桥接在线且后台程序持续运行。

## 数据与使用边界

聊天消息、结果和收藏保存在当前浏览器；清除浏览器数据、更换设备或使用隐私模式可能导致记录不可用。未发送的草稿仅在当前页面切换时保留，刷新后不会自动恢复，刷新也不能自动续接正在生成的任务。参考图编辑保留模型生成图的原始比例；1K、2K、4K 通过等比缩放得到，不会增加模型原生细节。

模板需要用户上传图片。用户可在手机上长按生成图保存，也可使用页面的保存按钮。建议在真实手机上检查键盘、安全区和长按行为。

当前 Cloudflare 地址：<https://yero-mobile-studio.pages.dev/>。
