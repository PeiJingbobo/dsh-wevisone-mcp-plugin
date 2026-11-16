# dsh-wevisone-mcp-plugin

[DeepSeek Harness](https://github.com/deepseek-ai) 原生插件：把 [WeVisOne-VL](https://github.com/Tencent/WeVisOne-VL) 的视觉感知能力接进 agent。

**核心价值**：插件跑在 DSH 主机进程内，能直接读本地图片、把结果写回本地文件。
图像字节和 alpha 掩码**都不进模型上下文**——模型只看到坐标和文件路径。

| | 通过 MCP 接入 | 本插件 |
|---|---|---|
| 输入 | 先上传或内联 base64 | **`image_path`，直接读文件** |
| 输出掩码 | 远程 URL，自己下载 | **落本地 PNG，返回 `local_path`** |
| 上下文成本 | 少量 | 更少 |

插件本身**不跑模型**：它连一台 WeVisOne-VL 服务（见
[WeVisOne-VL-MCP](https://github.com/PeiJingbobo/WeVisOne-VL-MCP)）。

> **它不是 MCP 客户端。** 名字里的 `mcp` 指它连的那个服务叫 WeVisOne-VL-**MCP**。
> 它通过 `ctx.tools.register()` 注册原生工具，用普通 HTTP REST（`/predict`、`/artifacts`）
> 和服务器通信 —— 不经过 MCP 的 JSON-RPC。要 MCP 协议本身请用主仓库的 MCP 端点。

## 安装

```sh
# 从 git 安装（纯 ESM，零依赖，无构建步骤）
dsh plugin add github:PeiJingbobo/dsh-wevisone-mcp-plugin

# 或者用 tarball
npm pack && dsh plugin add ./dsh-wevisone-mcp-plugin-*.tgz
```

安装后出现在 DSH 插件列表里，重启 DSH 生效。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-wevisone-mcp-plugin
  config:
    endpoint: http://192.168.1.12:8000
    token: !!js '`${process.env.WEVISONE_MCP_TOKEN || process.getBuiltinModule("node:fs").readFileSync(process.env.HOME + "/.dsh/wevisone-token", "utf8").trim()}`'
    maskDir: !!js '`${process.env.HOME}/wevisone-masks`'
    timeoutMs: 180000
```

| 键 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8000` | WeVisOne-VL 服务地址 |
| `token` | `$WEVISONE_MCP_TOKEN` | 共享令牌；建议从 0600 文件读，别写字面量 |
| `maskDir` | `<cwd>/wevisone-artifacts` | 掩码落盘目录 |
| `timeoutMs` | `180000` | 单次请求超时 |

`!!js` 的值是单引号字符串，**漏掉结尾引号会让 DSH 起不来**。改完先校验再重启：

```sh
node scripts/check_dsh_yaml.mjs     # 在 WeVisOne-VL-MCP 仓库里
```

## 技能（Skill）

插件会往 DSH 的技能目录里注册一个 **`wevisone-vision`** skill，内容是
`skills/wevisone-vision.md`：11 个任务的适用场景与 query 要求、返回字段怎么读
（归一化坐标、`rejected` 语义、掩码 `local_path`）、常见坑（别传 base64、
`detection` 不出掩码、一次一张图）。

作用是在模型调用工具**之前**就告诉它怎么用，而不是靠试错。内容改完不需要动代码，
重新 `dsh plugin add` 或重启 DSH 即可生效。

没有 `skills` 服务的环境会跳过这一步（只打一条警告），工具本身照常可用。

## 工具

### `wevisone_predict`

```js
wevisone_predict({
  image_path: "C:/photos/room.jpg",   // 或用 upload_id
  task: "segmentation",
  query: "sofa",
  save_dir: "wevisone-artifacts",     // 可选
})
```

返回 JSON 文本：

```json
{
  "ok": true, "task": "segmentation", "query": "sofa", "rejected": false,
  "response": "<ref>sofa</ref><box><30><454><964><876><OBJ></box>",
  "boxes": [[0.03, 0.454, 0.964, 0.876]], "box_count": 1,
  "artifact_count": 1,
  "artifacts": [{
    "index": 0, "url": "/artifacts/e5c3ac…", "bytes": 23538,
    "content_type": "image/png",
    "local_path": "/abs/wevisone-masks/segmentation-000-e5c3ac….png"
  }],
  "latency_s": 3.2
}
```

`task`：`detection` `referring` `point` `count_box` `count_point` `segmentation`
`matting` `ocr` `ocr_grounding` `visual_prompt` `freeform`。
目标不存在时 `rejected: true` 且 `boxes` 为空——模型不会编造坐标。

### `wevisone_doctor`

报告端点、令牌是否配置、掩码目录。预测失败先调它。

## 注意

- **不要与 `mcp-wevisone` 同时启用**：两套同类工具会让模型犹豫
- **DSH 运行时别跑 `pnpm install`**：宿主持有 pnpm store 锁，安装会无输出卡死
- 令牌轮换后要重启 DSH：连接头在建立时固定
- 需要 Node ≥ 22（用到全局 `fetch`）

## 许可

MIT
