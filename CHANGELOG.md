# Changelog

版本号在 `package.json`，运行时通过 `wevisone_doctor` 的 `version` 字段可见 ——
装完重启后调一次 doctor 就知道是不是新版（顺序不符说明没重新安装）。

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
