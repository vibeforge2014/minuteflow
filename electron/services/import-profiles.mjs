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

/**
 * 导入切块策略按引擎定制（切块边界吸附参数见 chunk-planning.mjs 的 tuning）。
 * Apple Speech 必须用更长的上下文窗口：实测连续中文会议音频用 10 秒句中截断时，
 * 本机识别器约六成块报「No speech detected」、成功块产出也骤减（336 秒连续语音
 * 只出 176 字）；30 秒块 + 20–40 秒上下限仍远在 helper 单次识别超时之内。
 * 远程/本地 Whisper 维持 10 秒网格（进度反馈密度优先）。
 */
export function chunkPlanDefaults(transport) {
  if (transport === "apple-speech") {
    return {
      chunkMs: 30_000,
      overlapMs: 3_000,
      planning: { targetMs: 30_000, windowMs: 4_000, minMs: 20_000, maxMs: 40_000 }
    };
  }
  return {
    chunkMs: 10_000,
    overlapMs: 2_000,
    planning: { targetMs: 10_000, windowMs: 2_500, minMs: 7_000, maxMs: 13_000 }
  };
}
