# Changelog

版本号在 `package.json`，运行时通过 `wevisone_doctor` 的 `version` 字段可见 ——
装完重启后调一次 doctor 就知道是不是新版（顺序不符说明没重新安装）。

## 0.6.1 — 2026-11-17

橙子复跑：0 次读图、0 张预览、alpha 峰值 255、角落 0、交付在 Downloads，token < 300k。
仍有一处双重付费：

- 两次 predict 都请求了 `compose`（下载 4 个 cutout 约 2.5 MB），最后却用自写脚本
  对 7 张掩码取并集交付 —— cutout 全被删掉。
- 两个 query（`orange fruit` + `green leaf`）导致两次推理（12.2s + 22.6s），
  且两次的 cutout 都不完整。

skill 补两条：`compose` 与自写脚本二选一（表格给出何时用哪个）；主体有多个部分时
一个 query 写全（"orange fruit with leaves"），第二次调用是另一个主体，cutout 不含前一批。

## 0.6.0 — 2026-11-17

橙子会话暴露两个真问题：token 没降、抠图边缘发灰。

- **修 alpha 量化（服务端）**：`(mask*255).astype(uint8)` 是截断，sigmoid 峰值 0.996
  落成 **254**，所有抠图内部只有 99.6% 不透明 —— 换背景就发灰。改为 `rint` + 近 1
  归 1，实测 255 出现（93,083 像素），边缘仍是真实软边。
- **`stats` 改用量化后的数组**，`alpha_max` 与文件一致（此前报 1.0、文件却是 254）。
- **服务端合成**：新参数 `compose: "union" | "each"`，直接返回 `cutouts[]`
  （full 保位置 / tight 按 `stats.bbox` 裁剪）。客户端不用写 Python，
  也就没有了 `/254` 补丁、`getbbox()` 裁不紧、resize 猜错这些坑。
- 插件端透传 `compose` 并下载 cutout，返回 `local_path`。

## 0.5.0 — 2026-11-17

两件事：skill 瘦身，以及成本可观测。

- **skill 12.8 KB → 7.6 KB（−41%）**，22 条关键规则逐条核对全部保留：
  工具优先、禁 base64、任务表、stats/verdict、读图三例外、禁预览图、
  禁手搓重建（mean|Δ| ≤ 2/255）、stats.bbox 裁剪、runtime python、
  原图名搜索、原位置二义、沙箱拒绝、present 最终位置、删脚本等。
- **`wevisone_doctor` 返回 `session` 计数**：`predict_calls` / `failed_calls` /
  `rejected_queries` / `artifacts` / `total_latency_s` / `avg_latency_s` /
  `last_task` / `last_latency_s` / `since`；传 `{"reset": true}` 先报后清零。
  这样「换了 skill 版本有没有变便宜」可以用数字比，不靠印象。
- 测试增至 18 项断言，覆盖计数与清零。

## 0.4.4 — 2026-11-17

人物会话：7 次调用、0 次读图、0 张预览、无权限拒绝 —— 目前最好的一轮。仍有两处可改：

- **裁剪用 `stats.bbox`**，不要用裸 `matte.getbbox()`：软 alpha 在边缘散布 α=1…12，
  `getbbox()` 会把几乎整幅画面当内容（实测 516×479，应为 471×432）。
- **合成脚本直接 `save()` 到最终目录**，从根上避免「复制到工作区外 → 被沙箱拒绝 →
  提权重试」这一串；提权重试降级为兜底。
- 收尾删掉辅助脚本，别把脚手架当交付物留下。

## 0.4.3 — 2026-11-17

黑猫会话：`read_image` 降到 0（目标达成），但用 4 次探查脚本替代了看图；
且复制到 Downloads 被沙箱拒绝后重试带提权才成功。

- skill 明确：`verdict: "ok"` 之后**不再写探查脚本**（区域统计、连通域审计、
  二次合成），需要额外数字就在同一个合成脚本里算，一次写完一次跑完。
- skill 新增「保存到工作区外的目录」：被沙箱拒绝不是改存别处的理由，
  要么原样重试 + `danger-full-access` + 理由，要么留在工作区并给出复制命令；
  `present` 要列最终位置的文件，不是中间副本。

## 0.4.2 — 2026-11-17

粉发女孩会话：0.4.1 已装上（doctor 报版本、mask_dir 修好、原图搜到、python 提前取），
但仍自造 `preview_overlay.png` / `preview_checker.png` 并读了 2 次图。

- 服务端 `stats` 新增 `verdict`（`ok` / `suspect` + `problems`），把「掩码能不能用」
  变成一次字符串比较，不需要再看图。
- skill 明确**不许自造预览/对比图**（棋盘格、overlay、三联对比），除非用户要；
  这类图会把整个场景（正是被抠掉的内容）带进上下文。
- skill 的校验顺序改为先读 `verdict`，把「看图」收窄到三种有理由的情形。
- pre-step 持久提醒补一句：不要造预览图、不要读它们。

## 0.4.1 — 2026-11-17

来自猫咪抠像会话（装了 stats 但没装 0.4.0 提示，读了 6 次图）：

- skill 明确「抠像最多读 1 次图」，并说明语义掩膜丢细节是常态、**不要因为边缘不完美
  就手工重建**；重建只在 stats 报警或用户要求更高边缘质量时做，且需满足
  `mean|Δ| ≤ 2/255` 的合成回验。
- skill 补 python 运行时规则：用 `load_workspace_dependencies` 给的解释器，
  系统 `python` 没有 PIL（此前白费一步）。
- 「放到原位置」的两种读法（画布坐标 / 原目录）一次全给，不再二选一。
- 插件检测 `maskDir` 里的字面量 `undefined`（Windows 上 `process.env.HOME` 未定义
  会导致），警告并回退到 `<家目录>/wevisone-artifacts`，不再往垃圾目录写掩码。

## 0.4.0 — 2026-11-17

- 服务端 `predict` 的每个 artifact 新增 `stats`：`coverage`、`alpha_min/max/mean`、
  `bbox`、`touches_edge`、`size`。
- skill 新增「用数字校验，不要看图」：给出正常区间与判定规则，并明确只有三情形
  才需要 `read_image`（多掩码抉择、数字报警后查看、用户要预览）。
  此前抠像任务会为「确认蒙版可用」读 1–3 次图，每次都是整图进上下文。

## 0.3.1 — 2026-11-17

- skill 补「保存到原位置」的做法：附件文件名就是用户的原始文件名，按其中的
  `u=<id>` 去 Downloads/Pictures/Desktop/Documents 搜，找到就落在原图旁边；
  找不到才反问。此前模型会直接反问路径，白丢一次往返，也没满足「原位置」。

## 0.3.0 — 2026-11-17

从真实抠像会话复盘出来的四项修正。

- **`save_dir` 生效**：此前只在 schema 里声明、执行时被忽略，掩码一律落配置的
  `maskDir`。现在单次调用的 `save_dir` 优先。
- **跨平台默认目录**：默认值改用 `os.homedir()`；文档与 profile 示例不再用
  `process.env.HOME`（Windows 上未定义，会生成字面量 `undefined` 目录）。
- **任务选择指导**：单目标抠像优先 `segmentation`；`matting` 会给每个 `<OBJ>`
  出一张掩码，多掩码时按面积取最大而不是 index。
- **合成配方**：skill 给出 `getbbox()` 裁剪 + `putalpha(matte)` 的一步写法，
  避免模型手写 PIL 反复试错。
- 新增 `wevisone_doctor` 的 `version` 字段；`test/save-dir.mjs` 覆盖
  `save_dir`、默认目录、版本一致性。

## 0.2.0 — 2026-11-17

- 新增 `wevisone-vision` skill（任务矩阵、字段含义、常见坑）。
- `agent/pre-step` 注入持久提醒 + 工具描述前置偏好，让模型优先用工具而非自带视觉。
- 修复 skill 加载失败：注册时补 `source`，否则 `skills.get()` 抛
  `source must be a string`。

## 0.1.0 — 2026-11-16

- 首个版本：`wevisone_predict` / `wevisone_doctor`，零依赖 ESM，REST 直连。
