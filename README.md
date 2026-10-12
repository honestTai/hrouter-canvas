# HRouter Canvas

给编程 agent 用的生图插件：agent 不会画图时调用它，图片保存成真实文件，同时出现在一块可以拖动、连线、继续创作的无限画布上。

- **适配主流 agent**：Claude Code、Codex、opencode、DeepSeek Harness，以及任何支持 MCP 的客户端。
- **站点和 Key 自己配**：支持任意兼容 OpenAI Images 或 Gemini 原生协议的站点，可以配多个。
- **本机运行**：画布、图片、配置都在你的电脑上，除了你配置的生图站点，不连任何服务器。
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

## 配置生图站点

第一次让 agent 画图时，画布的设置页会自动打开。填三样东西：

1. **站点地址**：例如 `https://hrouter.net`，填根地址或以 `/v1` 结尾的地址都可以。
2. **API Key**。
3. **模型**：点“测试并获取模型”从站点拉取，或手动填模型名。

内置了 [HRouter](https://hrouter.net) 预设，填上 Key 即可使用。

没有浏览器的环境（SSH、容器、CI）可以改用环境变量，写在 agent 的 MCP 配置里：

| 变量 | 说明 |
| --- | --- |
| `HROUTER_CANVAS_BASE_URL` | 站点地址 |
| `HROUTER_CANVAS_API_KEY` | API Key |
| `HROUTER_CANVAS_MODEL` | 默认模型 |
| `HROUTER_CANVAS_PROTOCOL` | `auto`（默认）、`openai` 或 `gemini` |
| `HROUTER_CANVAS_OPEN` | 设为 `never` 则从不自动打开浏览器 |
| `HROUTER_CANVAS_PORT` | 本机端口，默认 17861 |
| `HROUTER_CANVAS_HOME` | 数据目录，默认 `~/.hrouter-canvas` |

### 支持的协议

| 协议 | 文生图 | 带参考图 |
| --- | --- | --- |
| OpenAI Images | `POST /v1/images/generations` | `POST /v1/images/edits` |
| Gemini 原生 | `POST /v1beta/models/{model}:generateContent` | 同一接口，参考图内联 |

协议选“自动”时，`gemini-` 开头的模型走 Gemini 原生，其余走 OpenAI Images。站点返回 `b64_json` 或图片 URL 都能处理。

## 怎么用

直接对 agent 说：

- “帮我画一张 16:9 的产品发布会海报”
- “把 `assets/logo.png` 改成深色版，存到 `assets/`”
- “打开画布”

agent 可用的工具：

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文生图；带参考图时是改图。可指定比例、分辨率、数量、保存位置 |
| `open_canvas` | 打开画布或站点设置页 |
| `list_image_models` | 列出已配置的站点和模型（不含 Key） |

在画布上也可以直接生图、拖入图片、把图片设为参考、连线、删除和下载。

命令行：

```bash
npx hrouter-canvas-mcp open
```

其他子命令：`url`（打印带访问令牌的地址）、`status`、`stop`。

## 数据与安全

- **图片是文件**：保存在 `~/.hrouter-canvas/boards/` 下，agent 拿到的是绝对路径。在画布里删除图片会删除这个文件；通过 `save_to` 复制到项目里的副本不受影响。
- **Key 只在本机**：保存在 `~/.hrouter-canvas/config.json`，权限 0600。页面和 agent 都读不回 Key。
- **agent 不能配置站点**：所有工具都不接受站点地址或 Key 参数，防止提示词注入把 Key 发到别处。
- **只监听 127.0.0.1**：页面需要本机访问令牌，服务校验 Host 和 Origin，其他网站无法通过你的浏览器操作它。
- **生成结果不丢**：请求发出后，即使关掉页面或取消 agent 调用，结果仍会保存到画布。失败不会自动重试。
- **图片 URL 下载有限制**：站点返回图片 URL 时，只接受 https（或与站点同源）的地址，并校验确实是大小受限的 PNG、JPEG 或 WebP。
- 生图可能产生费用，以你配置的站点为准。

## 自动更新

所有安装方式都通过 `npx -y hrouter-canvas-mcp@latest` 启动，所以新版本发布后，下次启动 agent 就会用上；后台的画布服务发现版本变化会自动重启。想固定版本，把 `@latest` 换成具体版本号。

Claude Code 的插件外壳（技能和命令）通过插件市场更新：在 `/plugin` 的市场设置里开启自动更新，或手动运行 `claude plugin update hrouter-canvas@hrouter`。

## 本地开发

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` 会做类型检查、构建并运行测试。测试使用本地假站点，不会访问真实服务、不产生费用、不打开浏览器。

用本地构建接入 Claude Code：

```bash
claude mcp add hrouter-canvas -- node /绝对路径/hrouter-canvas/dist/cli.mjs
```

发布：修改 `package.json` 和 `.claude-plugin/plugin.json` 的版本号，推送 `v版本号` 标签，GitHub Actions 会发布到 npm（需要仓库密钥 `NPM_TOKEN`）。

## 与 image.hrouter.net 的关系

[image.hrouter.net](https://image.hrouter.net) 是 HRouter 的在线画布，使用 HRouter 账号登录。本项目是独立的本地版本，不依赖在线服务，两边的作品互不相通。

## 许可

[MIT](LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
