# 学习助手 · Study Assistant（桌面应用）

AI 驱动的错题整理与高考复习助手。基于 Electron，集成 DeepSeek / Kimi / Claude，
直接操作 docsify 错题知识库（默认 `..\网页`），支持错题录入、作文分析、分数预测、
档案/网页代码编辑、GitHub 同步。

**项目官网**：<https://studyassistant.kfdzcoffee.cn>

## 项目初衷

这是作者为了满足**自身记录错题**的需要，借助 AI 开发的项目。把它分享出来，只是觉得**可能有人会需要**而已。

## 功能

| 功能 | 说明 |
|------|------|
| 🏠 首页 | 高考/中考倒计时（设置中切换、设年份）+ 每日鸡汤 + 翻页式专注计时（可放大全屏，专注时长自动记录） |
| 🏗️ 一键构建知识库 | 首次使用无 docsify 站点时，自动生成与当前风格一致的 docsify 错题知识库（index/README/sidebar/各科档案/分数预测/编辑注意事项） |
| 🤖 多 AI 接入 | DeepSeek / Kimi(Moonshot) / Claude，均可配置 Base URL、模型、API Key（系统密钥环加密） |
| ✍️ 错题录入 | 粘贴文本或拍照/选图，AI 按知识库格式整理（错题/错因/日期/正确答案/错因分析/典型例题）；**支持一次录入多道**：先入「待录入区」，一键全部写入错题库 |
| 📝 作文分析 | 语文(50分制)/英语(20分制)，评分明细 + 错因逐条分析 + 纵向(历史作文)/横向对比 |
| 🎯 分数预测 | AI 读取**全部**科目档案与 分数预测.md，重新估算并更新 |
| 🔑 组卷密码 | 网页端「生成试卷」密码可在设置中单独配置并写入 index.html |
| 📚 档案编辑 | 直接编辑各科 md / _sidebar / README / 分数预测 / 网页代码(index.html、js/exam-builder.js)，保存自动 UTF-8+BOM |
| 🔁 Git 同步 | 按规范 clean → commit(修改内容-日期) → push(重试3次)，内置 AIGC 追踪串扫描 |
| 🌐 网页预览 | 本地服务器实时渲染 docsify 知识库 |
| 🔄 刷新页面 | 一键刷新整个界面以应用配置 |
| 🛡 操作确认 | AI 每次写文件 / Git 操作前弹窗展示 diff，须你同意才执行 |

## 使用

1. 确保已安装 [Node.js](https://nodejs.org)（≥ 18）。
2. 双击 `start.bat`（首次会自动 `npm install`）。
3. 首次启动进入**初始化向导**：选择知识库工作目录、配置 AI 提供商 API Key、确认系统提示词。
4. 若工作目录还没有 docsify 站点，会自动弹出「构建知识库」向导，一键生成。

## 目录结构

```
学习助手桌面端/
├── main.js                 # 主进程：窗口、IPC、本地服务器、AI 任务编排
├── preload.js              # 安全桥接（contextBridge）
└── src/
    ├── main/
    │   ├── settings.js     # 配置 + safeStorage 密钥环
    │   ├── http-server.js  # 本地静态服务器（预览）
    │   ├── workspace.js    # 文件服务（UTF-8+BOM）
    │   ├── git.js          # git clean/commit/push + AIGC 扫描
    │   ├── builder.js      # docsify 知识库构建器（含模板）
    │   ├── templates/      # 网页模板（index.html 等）
    │   ├── confirm-gate.js # 确认门
    │   └── ai/             # 适配器 + 代理循环 + 工具 + 提示词
    └── renderer/           # 界面（index.html / styles.css / app.js / markdown.js / logo）
```

## 说明

- 本应用位于知识库仓库**之外**（同级文件夹），不会污染 `StudyHall` 仓库。
- 配置存于系统用户目录（`userData/config.json`），API Key 经 `safeStorage` 加密。
- 所有 md 写入遵循知识库规范：**UTF-8+BOM**。
- push 前建议执行「🧹 AIGC 串扫描」检查污染。

## 许可证

本软件依据《学习助手-Study Assistant 开源终端软件使用许可协议》授权使用。

协议全文见：https://studyassistant.kfdzcoffee.cn/legal.html
