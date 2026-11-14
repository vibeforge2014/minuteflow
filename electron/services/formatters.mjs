/**
 * 会议内容的多格式输出工具（Electron 主进程 / 服务层入口）。
 * 实现已下沉到 shared/export-formatters.mjs，让渲染层的导出预览与真正写盘的文件
 * 共用同一份排版代码；这里保留原有导出名，主进程与测试的引用不变。
 */
export { formatTime, markdown, subtitle, exportNameSuffix, scopeLabel } from "../../shared/export-formatters.mjs";
