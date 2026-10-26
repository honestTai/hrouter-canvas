# HRouter Canvas

给编程 agent 用的生图、生视频插件：agent 不会画图时调用它，图片和视频保存成真实文件，同时出现在一块可以拖动、连线、继续创作的无限画布上。

- **先出图，再让图动起来**：agent 先在一个站点生成图片，再把这张图交给另一个站点生成视频，全程由 agent 驱动。生图站点和生视频站点分开配置，各用各的 Key。
- **画布和 agent 共享内容**：你在画布上选中、截帧、调整；对 agent 说“把我选中的视频接着做”，它能找到那一项、看到视频关键帧，再自己继续生成。
- **适配主流 agent**：Claude Code、Codex、opencode、DeepSeek Harness，以及任何支持 MCP 的客户端。
- **站点和 Key 自己配**：生图支持任意兼容 OpenAI Images 或 Gemini 原生协议的站点；生视频默认用 HRouter，也支持兼容 OpenAI Videos 的站点。可以配多个。
- **本机运行**：画布、图片、视频、配置都在你的电脑上，除了你配置的生图、生视频站点，不连任何服务器。
- **自动更新**：agent 每次启动都拉取最新版。

## 安装

需要 Node.js 20.3 或更高版本。

### Claude Code

```bash
claude plugin marketplace add honestTai/hrouter-canvas
```

```bash
claude plugin install hrouter-canvas@hrouter
```

插件自带 MCP 服务、技能和 `/canvas` 命令。

### Codex

```bash
codex mcp add hrouter-canvas -- npx -y hrouter-canvas-mcp@latest
```

### opencode

在 `opencode.json` 里加入：

```json
{
  "mcp": {
    "hrouter-canvas": {
      "type": "local",
      "command": ["npx", "-y", "hrouter-canvas-mcp@latest"],
      "enabled": true
    }
  }
}
```

### DeepSeek Harness（dsh）

在所用 profile 的 `cordis.yml` 里加一条：

```yaml
- id: mcp-hrouter-canvas
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: hrouter-canvas
    transport: stdio
    command: npx
    args: ['-y', 'hrouter-canvas-mcp@latest']
```

### 其他 MCP 客户端

配置一个 stdio 服务，命令是 `npx -y hrouter-canvas-mcp@latest`。

### 让 agent 更主动地用它（可选）

Claude Code 插件已包含技能。其他 agent 可以把本仓库的 `skills/image-canvas` 目录复制到它读取技能的位置，例如 dsh 会读的 `~/.agents/skills/`。

> Claude Code 的插件清单已用 `claude plugin validate --strict` 校验。Codex、opencode、dsh 的配置片段按各自官方文档编写，尚未逐一实测，遇到问题欢迎提 issue。

## 配置站点

第一次让 agent 画图或生视频时，如果还没有可用的站点，画布的设置页会自动打开。每个站点填三样东西：

1. **站点地址**：例如 `https://hrouter.net`，填根地址或以 `/v1` 结尾的地址都可以。
2. **API Key**。
3. **模型**：点“测试并获取模型”从站点拉取，或手动填模型名。

设置页分成**生图站点**和**生视频站点**两个列表，各自填地址和 Key，各有一个默认站点。图可以在站点 1 生成，再交给站点 2 生成视频，agent 不需要指定。

两个列表都内置了 [HRouter](https://hrouter.net) 预设，填上 Key 即可使用：生图预设带 `gpt-image-2`、`gemini-3.1-flash-image`，生视频预设“HRouter 视频”带 `grok-imagine-video-1.5`（默认）和 `grok-imagine-video`。HRouter 的 Key 按分组区分能力，生视频需要 grok 分组的 Key（见 [HRouter 生图与生视频文档](https://hrouter.net/docs/image-video/)），所以两边通常填不同的 Key。

没有浏览器的环境（SSH、容器、CI）可以改用环境变量，写在 agent 的 MCP 配置里：

| 变量 | 说明 |
| --- | --- |
| `HROUTER_CANVAS_BASE_URL` | 站点地址 |
| `HROUTER_CANVAS_API_KEY` | API Key |
| `HROUTER_CANVAS_MODEL` | 默认模型 |
| `HROUTER_CANVAS_PROTOCOL` | `auto`（默认）、`openai` 或 `gemini` |
| `HROUTER_CANVAS_VIDEO_MODEL` | 视频模型；设置后添加一个生视频站点，并设为默认 |
| `HROUTER_CANVAS_VIDEO_BASE_URL` | 生视频站点地址，不填则同 `HROUTER_CANVAS_BASE_URL` |
| `HROUTER_CANVAS_VIDEO_API_KEY` | 生视频站点的 Key，不填则同 `HROUTER_CANVAS_API_KEY` |
| `HROUTER_CANVAS_VIDEO_PROTOCOL` | `auto`（默认）、`xai` 或 `openai` |
| `HROUTER_CANVAS_OPEN` | 设为 `never` 则从不自动打开浏览器 |
| `HROUTER_CANVAS_FFMPEG` | 读取视频关键帧用的 ffmpeg 路径，默认在 PATH 中查找；设为 `off` 则只用画布页面解码 |
| `HROUTER_CANVAS_PORT` | 本机端口，默认 17861 |
| `HROUTER_CANVAS_HOME` | 数据目录，默认 `~/.hrouter-canvas` |

### 支持的协议

| 协议 | 文生图 | 带参考图 |
| --- | --- | --- |
| OpenAI Images | `POST /v1/images/generations` | `POST /v1/images/edits` |
| Gemini 原生 | `POST /v1beta/models/{model}:generateContent` | 同一接口，参考图内联 |

协议选“自动”时，`gemini-` 开头的模型走 Gemini 原生，其余走 OpenAI Images。站点返回 `b64_json` 或图片 URL 都能处理。

| 视频协议 | 提交任务 | 查询与下载 |
| --- | --- | --- |
| HRouter / xAI | `POST /v1/videos/generations` | `GET /v1/videos/generations/{id}`，完成后下载 `/content` |
| OpenAI Videos | `POST /v1/videos` | `GET /v1/videos/{id}`，完成后下载 `/content` |

视频协议选“自动”时，`sora-` 开头的模型走 OpenAI Videos，其余走 HRouter / xAI。视频是异步任务：提交后每 10 秒查询一次，完成后下载 MP4。图生视频时，首帧图片以内联方式随请求发送。

## 怎么用

直接对 agent 说：

- “帮我画一张 16:9 的产品发布会海报”
- “把 `assets/logo.png` 改成深色版，存到 `assets/`”
- “打开画布”
- “画一张雪山木屋的图，再让它动起来，镜头缓慢推进，8 秒”
- “把刚才那张海报做成一段 5 秒的视频”
- “把我在画布上选中的视频接着往下做，镜头拉远”
- “取这个视频第 3 秒的画面，改成夜景，再做成视频”

agent 可用的工具：

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文生图；带参考图时是改图。可指定比例、分辨率、数量、保存位置 |
| `generate_video` | 文生视频；传入图片 id 或路径时是图生视频。可指定时长、分辨率、保存位置 |
| `video_status` | 查询视频任务。agent 的调用中断或超时后，用它找回结果 |
| `list_canvas` | 列出画布上的图片和视频：id、提示词、模型、文件路径、由哪个生成，以及用户当前选中了哪些 |
| `view_canvas_item` | 查看一项内容：图片直接返回，视频返回 0、¼、½、¾ 处的四格关键帧 |
| `extract_frame` | 把视频的某一帧（开头、结尾或第几秒）存成画布上的图片，用来修改或继续生成 |
| `open_canvas` | 打开画布或站点设置页 |
| `list_image_models` | 分别列出生图站点和生视频站点及其模型（不含 Key） |

在画布上也可以直接生图、生视频（在图片上点“生成视频”，把它作为首帧）、截取视频画面、从视频结尾继续生成、拖入图片、把图片设为参考、连线、删除和下载。

画布和 agent 看到的是同一份内容：你在画布上选中一个视频，再对 agent 说“把我选中的视频接着往下做，镜头拉远”，agent 会先用 `list_canvas` 找到它、用 `view_canvas_item` 看关键帧，再自己调用生成工具。

agent 看视频靠关键帧：本机装了 ffmpeg 时由画布服务直接截取；没装时由已打开的画布页面用浏览器解码，所以无需额外安装。

视频通常要 1 到 5 分钟。Codex 默认 60 秒就会中断工具调用，可以在 `~/.codex/config.toml` 的 `[mcp_servers.hrouter-canvas]` 下加 `tool_timeout_sec = 900`。不加也不会丢结果：视频照常生成并出现在画布上，agent 可以用 `video_status` 查到文件路径。

命令行：

```bash
npx hrouter-canvas-mcp open
```

其他子命令：`url`（打印带访问令牌的地址）、`status`、`stop`。

## 数据与安全

- **图片和视频是文件**：保存在 `~/.hrouter-canvas/boards/` 下，agent 拿到的是绝对路径。在画布里删除会删除这个文件；通过 `save_to` 复制到项目里的副本不受影响。
- **Key 只在本机**：保存在 `~/.hrouter-canvas/config.json`，权限 0600。页面和 agent 都读不回 Key。
- **agent 不能配置站点**：所有工具都不接受站点地址或 Key 参数，防止提示词注入把 Key 发到别处。
- **只监听 127.0.0.1**：页面需要本机访问令牌，服务校验 Host 和 Origin，其他网站无法通过你的浏览器操作它。
- **agent 看到的画布**：`list_canvas` 和 `view_canvas_item` 只读取本机画布上的内容。你在画布上的选中状态只保存在内存里；视频关键帧缓存在对应画布目录的 `cache/` 下，删除视频时一并删除。
- **生成结果不丢**：请求发出后，即使关掉页面或取消 agent 调用，结果仍会保存到画布。失败不会自动重试；视频任务查询状态时遇到短暂网络错误会继续查询，但绝不重新提交。
- **图片 URL 下载有限制**：站点返回图片 URL 时，只接受 https（或与站点同源）的地址，并校验确实是大小受限的 PNG、JPEG 或 WebP。
- **视频只收 MP4**：下载的视频会校验文件结构，大小上限 256 MB。HRouter 从 `/content` 接口下载；其他站点返回的视频链接只接受 https（或与站点同源），下载时不带 Key。
- 生图、生视频可能产生费用，以你配置的站点为准。HRouter 视频按秒计费，在查询到完成时扣费，失败或过期不扣费。

## 自动更新

所有安装方式都通过 `npx -y hrouter-canvas-mcp@latest` 启动，所以新版本发布后，下次启动 agent 就会用上；后台的画布服务发现版本变化会自动重启，已打开的画布页面也会自动刷新。想固定版本，把 `@latest` 换成具体版本号。

Claude Code 的插件外壳（技能和命令）通过插件市场更新：在 `/plugin` 的市场设置里开启自动更新，或手动运行 `claude plugin update hrouter-canvas@hrouter`。

## 本地开发

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` 会做类型检查、构建并运行测试。测试使用本地假站点，不会访问真实服务、不产生费用、不打开浏览器。本机装了 ffmpeg 时会额外测试用 ffmpeg 读取视频帧，没装则跳过这一项。

用本地构建接入 Claude Code：

```bash
claude mcp add hrouter-canvas -- node /绝对路径/hrouter-canvas/dist/cli.mjs
```

发布：修改 `package.json` 和 `.claude-plugin/plugin.json` 的版本号，推送 `v版本号` 标签，GitHub Actions 会发布到 npm（需要仓库密钥 `NPM_TOKEN`）。

## 与 image.hrouter.net 的关系

[image.hrouter.net](https://image.hrouter.net) 是 HRouter 的在线画布，使用 HRouter 账号登录。本项目是独立的本地版本，不依赖在线服务，两边的作品互不相通。

## 许可

[MIT](LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
