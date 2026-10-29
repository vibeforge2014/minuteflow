/**
 * 导入任务档案解析与转写路由的纯逻辑（无 electron / 数据库依赖，可被 vitest 直测）。
 *
 * 智谱式多可用语义：所有已配置档案默认可用，具体用哪个由任务开启时的显式选择决定；
 * 未显式选择时回落到该类的「默认档」（is_default），再退到第一条可用档案。
 */

/** 本机 Whisper 四种运行时（whisper.cpp / Python / CT2 / MLX）需要先解析模型文件。 */
const WHISPER_RUNTIMES = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"];

/**
 * 通用档案解析：任务显式选择 > 默认档 > 第一条可用档案。
 * 主进程各任务（说话人分离/AI 问答兜底/导入队列）共用这一优先级。
 * @returns {object|null} 命中的档案；无可用档案时返回 null。
 */
export function resolveProfile(profiles, kind, profileId) {
  const ofKind = profiles.filter((profile) => profile.kind === kind);
  if (profileId) {
    const pinned = ofKind.find((profile) => profile.id === profileId);
    if (pinned) return pinned;
  }
  return ofKind.find((profile) => profile.isDefault)
    || ofKind.find((profile) => profile.enabled)
    || null;
}

/**
 * 解析任务实际使用的模型档案（导入队列：显式钉住 > 默认档 > 第一条可用；
 * 被钉住的档案即使停用也按任务执行）。
 * @returns {object|null} 命中的档案；无可用档案时返回 null（任务进入 waiting_for_model）。
 */
export function resolveJobProfile(profiles, kind, profileId) {
  if (profileId) {
    const pinned = profiles.find((profile) => profile.kind === kind && profile.id === profileId);
    if (pinned) return pinned;
  }
  return profiles.find((profile) => profile.kind === kind && profile.isDefault)
    || profiles.find((profile) => profile.kind === kind && profile.enabled)
    || null;
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
