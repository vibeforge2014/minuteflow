# 会议助手

本地优先的 Electron 跨平台会议工作台，支持边录音、边转录、边记录，并以两分钟为默认节奏生成结构化滚动纪要。

产品官网与在线演示：[vibeforge2014.github.io/meeting-assistant](https://vibeforge2014.github.io/meeting-assistant/)

## 已实现

- Windows/macOS 麦克风与系统音频双轨采集，15 秒音频块落盘
- 暂停、继续、停止、音量状态、重点时间戳和迷你窗口
- 本地 `whisper.cpp` 与 OpenAI 兼容远程转录适配器
- OpenAI、Azure OpenAI、DeepSeek、通义千问、Ollama 等 OpenAI 兼容总结配置
- 人工笔记、实时/最终转录、结构化 AI 纪要和会后编辑
- 首次启动隐私与权限引导、会议模板、术语表、可调总结间隔和录音保留周期
- 发言人标签改名、合并，以及线上会议“我/远端”声道初分
- 每两分钟增量总结、结束后的最终总结，以及文档版本冲突保护
- 会议搜索、标签、收藏、软删除与恢复
- MP3、M4A、WAV、FLAC、OGG、WebM、MP4、MOV 导入处理
- Markdown、PDF、DOCX、SRT、VTT、JSON 和 ZIP 备份导出
- SQLite/FTS5 本地数据库与系统安全存储中的 API Key

本地模型权重、FFmpeg、`whisper.cpp` 和 sherpa-onnx 权重不会静默打进安装包，需要由用户按需配置或下载。

## 本地开发

```bash
npm install
npm run dev:electron
```

仅预览界面：

```bash
npm run dev
```

## 验证与打包

```bash
npm run typecheck
npm test
npm run build
npm run package
```

`npm run make` 会在当前操作系统生成安装介质。跨平台构建工作流位于 `.github/workflows/build-desktop.yml`。正式发布前需要由发布方提供 Apple Developer ID、macOS 公证凭据和 Windows 代码签名证书。

## 隐私与数据

会议、转录、笔记、索引和录音默认位于 Electron 的应用数据目录。未配置远程模型时不会上传会议内容；配置远程服务后，只将对应转录片段或总结输入发送到用户选择的服务商。

## iPhone 与 iPad

原生 SwiftUI 通用应用位于 [`ios/MeetingAssistant`](ios/MeetingAssistant)，最低支持 iOS/iPadOS 18。

- iPhone：会议、行动项、设置三标签导航，会议详情内切换文档、转录与 AI 纪要
- iPad：自适应 `NavigationSplitView` 工作区，可并排编辑会议文档并查看实时转录
- SwiftData 本地数据库、麦克风录音、Apple Speech 实时/导入转录
- 本地基础纪要与 OpenAI 兼容远程纪要，远程 Whisper 导入适配器
- Keychain 密钥保存、音视频导入、Markdown/TXT/SRT/JSON 导出
- 收藏、搜索、软删除恢复、说话人改名和统一行动项列表

iOS 受系统沙箱限制，仅录制麦克风，不能捕获其他 App 的受保护系统音频。工程、构建和测试说明见 [`ios/MeetingAssistant/README.md`](ios/MeetingAssistant/README.md)。
