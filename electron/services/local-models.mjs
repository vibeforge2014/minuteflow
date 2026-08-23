/**
 * 本地 Whisper 模型的发现、下载与运行时装配（Electron 主进程 / 服务层）。
 * 实现"零路径配置"体验：自动扫描常见目录发现 .pt/GGML/GGUF 及目录式模型，
 * 提供带摘要校验的应用内下载，并探测应用托管的 whisper 运行时、Python 环境与 FFmpeg。
 * 下载源可在偏好中配置（官方 / hf-mirror.com 镜像 / 自定义 HF 兼容源或 {fileName} 模板），
 * 单源失败自动回退其余预设源；另支持自定义直链下载（无官方摘要，明确不校验）。
 * 主要导出：managedFfmpegPath、ensureManagedLocalRuntime、looksLikeWhisperModel、
 * discoverLocalModels、resolveLocalModelProfile、listDownloadableModels、downloadModel、
 * downloadFromUrl、buildModelDownloadUrl、MODEL_DOWNLOAD_SOURCES、describeLocalModel。
 * 被 main.mjs（models:scan-local / models:choose-local / models:catalog /
 * models:download / models:download-url）与 import-queue.mjs 调用。
 * 副作用：网络下载、子进程探测、写模型文件。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { loadWhisperModule } from "@fugood/whisper.node";

/** 支持的单文件模型扩展名 → 格式与引擎（whisper.cpp 走 GGML/GGUF，Python 走 .pt）。 */
const supportedExtensions = new Map([
  [".pt", { format: "PyTorch PT", engine: "whisper-python" }],
  [".bin", { format: "GGML / GGUF", engine: "whisper-cpp" }],
  [".gguf", { format: "GGUF", engine: "whisper-cpp" }]
]);

/**
 * 下载源预设：Hugging Face 官方与 hf-mirror.com 国内镜像（路径完全兼容，
 * 仅域名不同）。用户在偏好中选择，或提供自定义源（见 buildModelDownloadUrl）。
 */
export const MODEL_DOWNLOAD_SOURCES = {
  official: { label: "Hugging Face 官方", base: "https://huggingface.co" },
  mirror: { label: "hf-mirror.com 国内镜像", base: "https://hf-mirror.com" }
};

/**
 * 应用内可下载的模型目录（HuggingFace ggerganov/whisper.cpp 仓库，按用途分三组：
 * multilingual 多语言推荐 / quantized 轻量量化 / english 英文专用）。
 * 完整性校验用 sha256，摘要逐一取自 HuggingFace LFS 元数据（与仓库内文件一一对应），
 * 防止下载损坏或被篡改的模型进入托管目录；换下载源不影响摘要校验。
 */
const catalog = [
  {
    id: "ggml-tiny",
    name: "Whisper Tiny（GGML）",
    description: "最快、占用最低，适合快速草稿和低配置设备。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 77_691_713,
    fileName: "ggml-tiny.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-base",
    name: "Whisper Base（GGML）",
    description: "轻量日常转写，速度和准确率优于 Tiny。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 147_951_465,
    fileName: "ggml-base.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-small",
    name: "Whisper Small（GGML）",
    description: "中英混合表现均衡，推荐大多数会议使用。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 487_601_967,
    fileName: "ggml-small.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-medium",
    name: "Whisper Medium（GGML）",
    description: "更重视中文和复杂音频准确率，推荐 16GB 内存。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 1_533_763_059,
    fileName: "ggml-medium.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-large-v3-turbo-q5_0",
    name: "Whisper Large v3 Turbo Q5（GGML）",
    description: "Turbo 的 5-bit 量化版，约 0.55GB，中低配设备的准确率优选。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 574_041_195,
    fileName: "ggml-large-v3-turbo-q5_0.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-large-v3-turbo",
    name: "Whisper Large v3 Turbo（GGML）",
    description: "高准确率与速度兼顾，适合性能较好的新款电脑。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 1_624_555_275,
    fileName: "ggml-large-v3-turbo.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-large-v3",
    name: "Whisper Large v3（GGML）",
    description: "最高准确率，下载和运行占用较高，推荐 24GB 以上内存。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "multilingual",
    sizeBytes: 3_095_033_483,
    fileName: "ggml-large-v3.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-medium-q5_0",
    name: "Whisper Medium Q5（GGML）",
    description: "Medium 的 5-bit 量化版，约 0.52GB，存储紧张时的中文优选。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "quantized",
    sizeBytes: 539_212_467,
    fileName: "ggml-medium-q5_0.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-medium-q8_0",
    name: "Whisper Medium Q8（GGML）",
    description: "Medium 的 8-bit 量化版，约 0.8GB，接近原版准确率。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "quantized",
    sizeBytes: 823_369_779,
    fileName: "ggml-medium-q8_0.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-large-v3-q5_0",
    name: "Whisper Large v3 Q5（GGML）",
    description: "Large v3 的 5-bit 量化版，约 1GB，以更小体积获得旗舰准确率。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "quantized",
    sizeBytes: 1_081_140_203,
    fileName: "ggml-large-v3-q5_0.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-large-v3-turbo-q8_0",
    name: "Whisper Large v3 Turbo Q8（GGML）",
    description: "Turbo 的 8-bit 量化版，约 0.86GB，速度与准确率更均衡。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "quantized",
    sizeBytes: 874_188_075,
    fileName: "ggml-large-v3-turbo-q8_0.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-tiny.en",
    name: "Whisper Tiny.en（GGML）",
    description: "仅英文。占用最低的英文会议速记。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "english",
    sizeBytes: 77_704_715,
    fileName: "ggml-tiny.en.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-base.en",
    name: "Whisper Base.en（GGML）",
    description: "仅英文。轻量英文转写，速度和准确率优于 Tiny.en。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "english",
    sizeBytes: 147_964_211,
    fileName: "ggml-base.en.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-small.en",
    name: "Whisper Small.en（GGML）",
    description: "仅英文。英文会议的均衡之选。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "english",
    sizeBytes: 487_614_201,
    fileName: "ggml-small.en.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-medium.en",
    name: "Whisper Medium.en（GGML）",
    description: "仅英文。复杂英文音频的准确率优选。",
    engine: "whisper-cpp",
    format: "GGML",
    group: "english",
    sizeBytes: 1_533_774_781,
    fileName: "ggml-medium.en.bin",
    repo: "ggerganov/whisper.cpp",
    digestAlgorithm: "sha256",
    digest: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865fa8f6da4356",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  }
];

/** 打包后可执行文件在 asar 内无法执行，需重定向到 app.asar.unpacked 下的真实文件。 */
function unpackedExecutablePath(filePath) {
  if (!filePath?.includes("app.asar")) return filePath;
  return filePath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
}

/**
 * 应用内置 FFmpeg 的可用路径（unpacked 后）。不从系统 PATH 发现 FFmpeg：
 * 音频工具是 MinuteFlow 的托管运行时，安装包缺失时应明确报错，不把配置责任转给用户。
 */
export async function managedFfmpegPath() {
  const candidate = unpackedExecutablePath(ffmpegInstaller.path);
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

/** 探测应用托管的 whisper 运行时（@fugood/whisper.node）能否加载。 */
async function managedWhisperReady() {
  try {
    const runtime = await loadWhisperModule();
    return Boolean(runtime?.WhisperContext);
  } catch {
    return false;
  }
}

/**
 * 探测本机可用的转写环境（副作用：拉起 python 子进程做包探测）。
 * 返回 paths（找到的 whisper-cli / python / ffmpeg 可执行文件）与
 * runtimes（托管 whisper、whisper.cpp、python、ffmpeg、faster-whisper、mlx-whisper 的就绪布尔值）。
 */
async function discoverLocalEnvironment() {
  const python = await findExecutable(process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]);
  const [managedWhisper, bundledFfmpeg, whisperCpp] = await Promise.all([
    managedWhisperReady(),
    managedFfmpegPath(),
    findExecutable(["whisper-cli", "whisper-cpp"])
  ]);
  return {
    paths: {
      whisperCpp,
      python,
      ffmpeg: bundledFfmpeg
    },
    runtimes: {
      managedWhisper,
      whisperCpp: Boolean(whisperCpp),
      python: Boolean(python),
      ffmpeg: Boolean(bundledFfmpeg),
      fasterWhisper: await probePythonPackage(python, "faster_whisper"),
      mlxWhisper: process.platform === "darwin" ? await probePythonPackage(python, "mlx_whisper") : false
    }
  };
}

/**
 * 确保托管本地运行时（whisper.node + 内置 FFmpeg）可用，缺组件时抛出可读错误。
 * 下载模型前先调用，保证下载完成后模型立即可用。
 * @returns {Promise<object>} discoverLocalEnvironment 的探测结果
 */
export async function ensureManagedLocalRuntime() {
  const environment = await discoverLocalEnvironment();
  const missing = [];
  if (!environment.runtimes.managedWhisper) missing.push("本地转写组件");
  if (!environment.runtimes.ffmpeg) missing.push("音频处理组件");
  if (missing.length) {
    throw new Error(`${missing.join("和")}未能加载，请重新安装应用或稍后重试。`);
  }
  return environment;
}

/** access 探测文件是否存在（不抛错版本）。 */
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 按扩展名把模型文件描述为统一描述符（path/name/sizeBytes/format/engine），不认识返回 null。 */
function describeModel(filePath, sizeBytes = 0) {
  const extension = path.extname(filePath).toLowerCase();
  const descriptor = supportedExtensions.get(extension);
  if (!descriptor) return null;
  return {
    path: filePath,
    name: path.basename(filePath),
    sizeBytes,
    ...descriptor
  };
}

// Recognize directory-based Whisper models that are not single checkpoint files:
//   - CTranslate2 (faster-whisper): model.bin + config.json
//   - MLX (mlx-whisper): weights.npz + config.json
// config.json is parsed and must look like a Whisper model so unrelated
// config.json+weights directories (other HF models) are not misdetected.
// 识别目录式 Whisper 模型（faster-whisper 的 CTranslate2、MLX）：
// 必须带 config.json 且内容确属 Whisper，避免把其他 HuggingFace 模型目录误判。
async function describeModelDirectory(dirPath) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  if (!names.has("config.json")) return null;
  let config;
  try {
    config = JSON.parse(await readFile(path.join(dirPath, "config.json"), "utf8"));
  } catch {
    return null;
  }
  const isWhisper = config?.model_type === "whisper"
    || (Array.isArray(config?.architectures) && config.architectures.some((item) => /whisper/i.test(String(item))))
    || /whisper/i.test(JSON.stringify(config));
  if (!isWhisper) return null;
  if (names.has("model.bin")) {
    return { path: dirPath, name: path.basename(dirPath), format: "CTranslate2", engine: "faster-whisper", sizeBytes: 0 };
  }
  if (names.has("weights.npz")) {
    return { path: dirPath, name: path.basename(dirPath), format: "MLX", engine: "mlx-whisper", sizeBytes: 0 };
  }
  return null;
}

/** 用 import 探测 Python 包是否已安装（超时即视为未安装），失败/超时都返回 false。 */
function probePythonPackage(pythonPath, pkg, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    if (!pythonPath) return resolve(false);
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const child = spawn(pythonPath, ["-c", `import importlib; importlib.import_module(${JSON.stringify(pkg)})`], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/** 先按大小（≥30MB）与文件名关键词粗筛，过滤同名但非 Whisper 的 .pt/.bin/.gguf 文件。 */
export function looksLikeWhisperModel(filePath, sizeBytes) {
  if (sizeBytes < 30_000_000) return false;
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath, extension).toLowerCase();
  if (extension === ".pt") {
    return /(whisper|tiny|base|small|medium|large|turbo)/.test(name);
  }
  return /(whisper|ggml)/.test(name);
}

/**
 * 有界递归扫描目录收集模型：深度 ≤5、累计访问 ≤3000 项，防止误把超大目录
 * （如整个用户主目录）当扫描根导致长时间卡死。识别到的模型目录作为单条结果返回，不再深入。
 */
async function scanDirectory(root, output, state, depth = 0) {
  if (depth > 5 || state.visited >= 3_000 || !(await exists(root))) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.visited >= 3_000) return;
    state.visited += 1;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const dirDescriptor = await describeModelDirectory(target);
      if (dirDescriptor) {
        output.push(dirDescriptor);
        continue; // Present a model directory as a single model; do not scan inside.
      }
      if (!entry.name.startsWith(".") || [".cache"].includes(entry.name)) {
        await scanDirectory(target, output, state, depth + 1);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const descriptor = describeModel(target);
    if (!descriptor) continue;
    const fileStat = await stat(target).catch(() => null);
    const sizeBytes = fileStat?.size ?? 0;
    if (looksLikeWhisperModel(target, sizeBytes)) {
      output.push({ ...descriptor, sizeBytes });
    }
  }
}

/**
 * 在 PATH 与常见安装目录（Homebrew 等）中查找可执行文件；
 * Windows 上按 PATHEXT 逐个扩展名尝试。
 * @returns {Promise<string|undefined>} 找到的绝对路径
 */
async function findExecutable(names) {
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin"
  ].filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of directories) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Continue searching the bounded PATH list.
        }
      }
    }
  }
  return undefined;
}

/** 扫描全部根目录（去重）收集模型，按中文名排序并按路径去重。 */
async function scanLocalModels({ roots, modelDirectory }) {
  const models = [];
  const state = { visited: 0 };
  for (const root of Array.from(new Set([...roots, modelDirectory]))) {
    await scanDirectory(root, models, state);
  }
  return Array.from(new Map(models.map((item) => [item.path, item])).values())
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

/**
 * 发现本地模型与环境（models:scan-local 通道调用，设置页"发现本地模型"流程）。
 * 并行执行目录扫描与环境探测，返回 { models, runtimes }。
 */
export async function discoverLocalModels({ roots, modelDirectory }) {
  const [models, environment] = await Promise.all([
    scanLocalModels({ roots, modelDirectory }),
    discoverLocalEnvironment()
  ]);
  return {
    models,
    runtimes: environment.runtimes
  };
}

/**
 * 把用户保存的模型档案解析为可直接执行的形态（main.mjs 与导入队列转录前调用）。
 * 缺什么自动补什么：模型路径按引擎匹配首个扫描结果；whisper.cpp 优先托管运行时、
 * 托管不可用时才用 PATH 里的 whisper-cli；Python 系补解释器路径；FFmpeg 始终注入应用内置路径。
 * @returns {Promise<{profile, discovery, readiness}>} readiness.status 为
 *   ready / invalid_model / missing_components，供 UI 给出针对性提示。
 */
export async function resolveLocalModelProfile(profile, { roots, modelDirectory }) {
  const [models, environment] = await Promise.all([
    scanLocalModels({ roots, modelDirectory }),
    discoverLocalEnvironment()
  ]);
  const discovery = { models, runtimes: environment.runtimes };
  const matchingModel = discovery.models.find((model) => model.engine === profile.transport);
  const isPythonBased = ["whisper-python", "faster-whisper", "mlx-whisper"].includes(profile.transport);
  const options = {
    ...profile.options,
    ...(!profile.options?.modelPath && matchingModel ? { modelPath: matchingModel.path } : {}),
    ...(profile.transport === "whisper-cpp" && !environment.runtimes.managedWhisper && !profile.options?.executablePath && environment.paths.whisperCpp
      ? { executablePath: environment.paths.whisperCpp } : {}),
    ...(isPythonBased && !profile.options?.pythonExecutablePath && environment.paths.python
      ? { pythonExecutablePath: environment.paths.python } : {}),
    ...(environment.paths.ffmpeg ? { ffmpegPath: environment.paths.ffmpeg } : {})
  };
  const resolvedProfile = { ...profile, options };
  const modelStat = options.modelPath ? await stat(options.modelPath).catch(() => null) : null;
  const modelReady = Boolean(modelStat && (modelStat.isDirectory() || modelStat.size > 0));
  const runtimeReady = profile.transport === "whisper-cpp"
    ? Boolean(environment.runtimes.managedWhisper || options.executablePath)
    : Boolean(options.pythonExecutablePath || options.executablePath);
  const missing = [
    !modelReady && "模型文件",
    !runtimeReady && "本地转写组件",
    !options.ffmpegPath && "音频处理组件"
  ].filter(Boolean);
  return {
    profile: resolvedProfile,
    discovery,
    readiness: {
      status: missing.length ? (options.modelPath && !modelReady ? "invalid_model" : "missing_components") : "ready",
      missing,
      message: missing.length ? `${missing.join("、")}尚未就绪。` : "本地转写已就绪。"
    }
  };
}

/** 列出可下载模型目录并标注每项是否已安装在本机（models:catalog 通道调用）。 */
export async function listDownloadableModels(modelDirectory) {
  return Promise.all(catalog.map(async ({ repo: _repo, digest: _digest, ...item }) => {
    const localPath = path.join(modelDirectory, item.fileName);
    const fileStat = await stat(localPath).catch(() => null);
    return {
      ...item,
      installed: Boolean(fileStat?.size),
      localPath: fileStat?.size ? localPath : undefined
    };
  }));
}

/**
 * 依据下载源生成模型下载 URL。base 两种形态：
 *   - 含 {fileName} 占位符的链接模板（如 https://example.com/models/{fileName}），原样替换；
 *   - HuggingFace 兼容站点根地址（如 https://hf-mirror.com），按
 *     `${base}/${repo}/resolve/main/${fileName}?download=true` 拼接。
 * base 为空返回 null（调用方跳过该源）。
 */
export function buildModelDownloadUrl(item, base) {
  const trimmed = String(base ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.includes("{fileName}")) {
    return trimmed.replaceAll("{fileName}", item.fileName);
  }
  const repo = item.repo ?? "ggerganov/whisper.cpp";
  return `${trimmed.replace(/\/+$/, "")}/${repo}/resolve/main/${item.fileName}?download=true`;
}

/**
 * 解析下载尝试顺序：用户选定源优先，其后自动补齐官方与镜像作回退（去重、去无效源），
 * 单一源故障（常见为官方源直连失败）时下载仍能完成。
 */
function resolveSourceAttempts({ sourceKind, customBase } = {}) {
  const order = [];
  const add = (kind, base, label) => {
    const host = String(base ?? "").trim();
    if (!host || order.some((attempt) => attempt.base === host)) return;
    order.push({ kind, base: host, label });
  };
  if (sourceKind === "custom") add("custom", customBase, "自定义源");
  else if (sourceKind === "mirror") add("mirror", MODEL_DOWNLOAD_SOURCES.mirror.base, MODEL_DOWNLOAD_SOURCES.mirror.label);
  else add("official", MODEL_DOWNLOAD_SOURCES.official.base, MODEL_DOWNLOAD_SOURCES.official.label);
  add("official", MODEL_DOWNLOAD_SOURCES.official.base, MODEL_DOWNLOAD_SOURCES.official.label);
  add("mirror", MODEL_DOWNLOAD_SOURCES.mirror.base, MODEL_DOWNLOAD_SOURCES.mirror.label);
  return order;
}

// Dedupe concurrent downloads of the same model and throttle progress events so
// a large model download does not flood the renderer with one IPC per ~16KB chunk.
const activeDownloads = new Map();

/** 等待响应头的上限；被墙或失效的源常表现为迟迟不返回，超时即中止换源。 */
const DOWNLOAD_HEADER_TIMEOUT_MS = 45_000;
/** 数据流空闲上限：收到响应头后任一 60 秒窗口内无新数据即判定源不可用。 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/** 把底层网络错误翻译为可读的失败原因（用于多源回退时的汇总报错）。 */
function describeDownloadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|TIMEOUT|ETIMEDOUT/i.test(message)) return "连接超时或中断";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(message)) return "无法建立连接";
  return message;
}

/**
 * 下载指定目录模型（models:download 通道调用）。副作用：网络下载、写模型文件、子进程。
 * 同一模型的并发下载去重为同一 Promise；按"选定源 → 官方 → 镜像"顺序逐源尝试，
 * 单源失败（网络错误 / 非 2xx / 超时 / 摘要不符）清理临时文件后换下一个源；
 * 进度节流至 250ms 一次，经 onProgress 回调（main.mjs 转发为 models:download-progress 事件）上报。
 * @param {object} sourceOptions 偏好中的下载源配置（sourceKind / customBase）
 * @returns {Promise<object>} 下载完成后的模型描述符
 */
export async function downloadModel(modelId, modelDirectory, onProgress = () => {}, sourceOptions = {}) {
  if (activeDownloads.has(modelId)) return activeDownloads.get(modelId);
  const promise = doDownloadModel(modelId, modelDirectory, onProgress, sourceOptions);
  activeDownloads.set(modelId, promise);
  try {
    return await promise;
  } finally {
    activeDownloads.delete(modelId);
  }
}

/**
 * 目录模型的实际下载流程：先确保托管运行时可用 → 逐源流式写入 .download 临时文件
 * 并逐块更新摘要 → 校验 sha256（不符即删除重试下一源，防止半截或被篡改文件入库）→
 * 原子 rename 为正式文件名。
 */
async function doDownloadModel(modelId, modelDirectory, onProgress = () => {}, sourceOptions = {}) {
  const item = catalog.find((candidate) => candidate.id === modelId);
  if (!item) throw new Error("未找到可下载的模型。");
  onProgress({ modelId, downloadedBytes: 0, totalBytes: item.sizeBytes, status: "preparing", message: "正在准备本地转写组件…" });
  await ensureManagedLocalRuntime();
  await mkdir(modelDirectory, { recursive: true });
  const attempts = resolveSourceAttempts(sourceOptions);
  const failures = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const url = buildModelDownloadUrl(item, attempt.base);
    if (!url) {
      failures.push(`${attempt.label}：源地址无效`);
      continue;
    }
    if (index > 0) {
      onProgress({ modelId, downloadedBytes: 0, totalBytes: item.sizeBytes, status: "preparing", message: `上一下载源不可用，正在尝试${attempt.label}…` });
    }
    try {
      const sizeBytes = await downloadToFile(url, path.join(modelDirectory, item.fileName), {
        modelId,
        totalBytes: item.sizeBytes,
        digestAlgorithm: item.digestAlgorithm,
        digest: item.digest,
        onProgress,
        downloadingMessage: `正在从${attempt.label}下载模型…`
      });
      onProgress({ modelId, downloadedBytes: sizeBytes, totalBytes: sizeBytes, status: "ready", message: "模型与转写组件已就绪。" });
      return describeModel(path.join(modelDirectory, item.fileName), sizeBytes);
    } catch (error) {
      failures.push(`${attempt.label}：${describeDownloadError(error)}`);
    }
  }
  throw new Error(`模型下载失败，已尝试 ${failures.length} 个下载源。${failures.join("；")}`);
}

/**
 * 从自定义直链下载模型（models:download-url 通道调用）。链接须为 http(s) 且直接指向
 * .pt/.bin/.gguf 文件；没有官方摘要可校验，进度消息明确提示不校验完整性。
 * 进度与去重键统一为 `custom:<fileName>`，与目录模型共用一条进度事件流。
 * @returns {Promise<object>} 下载完成后的模型描述符
 */
export async function downloadFromUrl(url, modelDirectory, onProgress = () => {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("下载链接无效，请输入完整的 http(s) 地址。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http(s) 下载链接。");
  }
  // 文件名取 URL 末段；替换解码后可能混入的路径分隔符，防止写到目标目录之外。
  const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "")
    .replace(/[/\\]+/g, "-")
    .slice(0, 200)
    .trim();
  if (!supportedExtensions.has(path.extname(fileName).toLowerCase())) {
    throw new Error("链接需要直接指向 .pt、.bin 或 .gguf 模型文件。");
  }
  const modelId = `custom:${fileName}`;
  if (activeDownloads.has(modelId)) return activeDownloads.get(modelId);
  const promise = doDownloadFromUrl(parsed.toString(), fileName, modelId, modelDirectory, onProgress);
  activeDownloads.set(modelId, promise);
  try {
    return await promise;
  } finally {
    activeDownloads.delete(modelId);
  }
}

/** 自定义直链的实际下载流程：同一条流式管线，但不做摘要校验。 */
async function doDownloadFromUrl(url, fileName, modelId, modelDirectory, onProgress) {
  onProgress({ modelId, downloadedBytes: 0, totalBytes: 0, status: "preparing", message: "正在准备本地转写组件…" });
  await ensureManagedLocalRuntime();
  await mkdir(modelDirectory, { recursive: true });
  const target = path.join(modelDirectory, fileName);
  const sizeBytes = await downloadToFile(url, target, {
    modelId,
    totalBytes: 0,
    onProgress,
    downloadingMessage: "正在下载模型（自定义来源，不校验完整性）…"
  });
  onProgress({ modelId, downloadedBytes: sizeBytes, totalBytes: sizeBytes, status: "ready", message: "模型已就绪（自定义来源，未做完整性校验）。" });
  return describeModel(target, sizeBytes);
}

/**
 * 流式下载到 .download 临时文件再原子改名的共享管线：
 * 响应头 45 秒 / 数据流空闲 60 秒即中止（避免不可达源无限挂起）；
 * 提供摘要时逐块更新并在落盘前校验，不符即删除临时文件；可选跳过校验（自定义直链）。
 * 进度节流至 250ms 一次。
 * @returns {Promise<number>} 实际下载的字节数
 */
async function downloadToFile(url, target, {
  modelId,
  totalBytes = 0,
  digestAlgorithm = null,
  digest = null,
  onProgress = () => {},
  downloadingMessage = "正在下载模型…"
}) {
  const temporary = `${target}.download`;
  const controller = new AbortController();
  let idleTimer = null;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error("下载超时：源长时间无响应")), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const headerTimer = setTimeout(() => controller.abort(new Error("连接超时：源未响应")), DOWNLOAD_HEADER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`HTTP ${response.status}`);
  }
  const expectedTotal = Number(response.headers.get("content-length")) || totalBytes;
  const hash = digestAlgorithm && digest ? createHash(digestAlgorithm) : null;
  const file = await open(temporary, "w");
  let downloadedBytes = 0;
  let lastProgressAt = 0;
  armIdleTimer();
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      await file.write(buffer);
      hash?.update(buffer);
      downloadedBytes += buffer.byteLength;
      armIdleTimer();
      // Throttle progress to at most once per 250ms to avoid IPC flooding.
      const now = Date.now();
      if (now - lastProgressAt >= 250 || downloadedBytes >= expectedTotal) {
        lastProgressAt = now;
        onProgress({ modelId, downloadedBytes, totalBytes: expectedTotal, status: "downloading", message: downloadingMessage });
      }
    }
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
  await file.close();
  if (hash && digest) {
    onProgress({ modelId, downloadedBytes, totalBytes: expectedTotal, status: "verifying", message: "正在校验模型完整性…" });
    if (hash.digest("hex") !== digest) {
      await unlink(temporary).catch(() => {});
      throw new Error("模型校验失败，下载文件已删除。");
    }
  }
  await rename(temporary, target);
  return downloadedBytes;
}

/** 描述用户手动选择的模型文件（models:choose-local 通道调用）。 */
export function describeLocalModel(filePath, sizeBytes = 0) {
  return describeModel(filePath, sizeBytes);
}
