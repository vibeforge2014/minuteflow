/**
 * 导入任务档案解析与转写路由的纯逻辑（无 electron / 数据库依赖，可被 vitest 直测）。
 *
 * 导入抽屉允许为单个任务显式选择一个已保存档案——它与设置目录里全局唯一的
 * 「正在使用」开关相互独立：被显式钉住的档案即使当前未启用也按任务执行；
 * 没有钉住（或钉住的档案已被删除）时回落到当前启用的档案。
 */

/** 本机 Whisper 四种运行时（whisper.cpp / Python / CT2 / MLX）需要先解析模型文件。 */
const WHISPER_RUNTIMES = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"];

/**
 * 解析任务实际使用的模型档案。
 * @returns {object|null} 命中的档案；无可用档案时返回 null（任务进入 waiting_for_model）。
 */
export function resolveJobProfile(profiles, kind, profileId) {
  if (profileId) {
    const pinned = profiles.find((profile) => profile.kind === kind && profile.id === profileId);
    if (pinned) return pinned;
  }
  return profiles.find((profile) => profile.kind === kind && profile.enabled) || null;
}

/**
 * 导入转录块走哪条执行路径。
 * apple-speech 是本机引擎：掉进 remote 路径会拿空 baseUrl 发 HTTP 请求，
 * 表现为「选了 Apple 语音识别却报网络错误」——这里把路由钉死，防止回归。
 * @returns {"apple-speech"|"whisper"|"remote"}
 */
export function importTranscriptionRoute(transport) {
  if (transport === "apple-speech") return "apple-speech";
  return WHISPER_RUNTIMES.includes(transport) ? "whisper" : "remote";
}
