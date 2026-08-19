# Third-Party Notices

会议助手使用的开源依赖及其许可证以安装时生成的 `package-lock.json` 和各包内许可证文件为准。

本应用不会静默捆绑语音模型权重；桌面包会捆绑音频处理与 Whisper 运行时。用或分发下列组件时，应同时查看对应许可证：

- Electron — MIT
- React — MIT
- TipTap — MIT
- Phosphor Icons — MIT
- OpenCC-JS — MIT AND Apache-2.0
- whisper.cpp / @fugood/whisper.node — MIT
- FFmpeg / @ffmpeg-installer — 许可条款取决于各平台二进制的实际构建选项；发布前必须审核构建配置并随包提供匹配的许可证、声明与源码获取方式
- sherpa-onnx — Apache-2.0；模型许可证可能不同
- OpenAI Whisper model weights — MIT

发布构建前，应使用锁定依赖重新生成完整的第三方许可证清单。
