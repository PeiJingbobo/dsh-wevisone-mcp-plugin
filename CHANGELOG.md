# Changelog

版本号在 `package.json`，运行时通过 `wevisone_doctor` 的 `version` 字段可见 ——
装完重启后调一次 doctor 就知道是不是新版（顺序不符说明没重新安装）。

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
