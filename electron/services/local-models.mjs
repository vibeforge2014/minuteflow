import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { loadWhisperModule } from "@fugood/whisper.node";

const supportedExtensions = new Map([
  [".pt", { format: "PyTorch PT", engine: "whisper-python" }],
  [".bin", { format: "GGML / GGUF", engine: "whisper-cpp" }],
  [".gguf", { format: "GGUF", engine: "whisper-cpp" }]
]);

const catalog = [
  {
    id: "ggml-base",
    name: "Whisper Base（GGML）",
    description: "速度优先，适合普通办公电脑。",
    engine: "whisper-cpp",
    format: "GGML",
    sizeBytes: 148_000_000,
    fileName: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true",
    digestAlgorithm: "sha1",
    digest: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  },
  {
    id: "ggml-small",
    name: "Whisper Small（GGML）",
    description: "中英混合准确率更好，推荐 16GB 内存设备。",
    engine: "whisper-cpp",
    format: "GGML",
    sizeBytes: 488_000_000,
    fileName: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true",
    digestAlgorithm: "sha1",
    digest: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    source: "ggerganov/whisper.cpp",
    license: "MIT"
  }
];

function unpackedExecutablePath(filePath) {
  if (!filePath?.includes("app.asar")) return filePath;
  return filePath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
}

export async function managedFfmpegPath() {
  const candidate = unpackedExecutablePath(ffmpegInstaller.path);
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function managedWhisperReady() {
  try {
    const runtime = await loadWhisperModule();
    return Boolean(runtime?.WhisperContext);
  } catch {
    return false;
  }
}

async function discoverLocalEnvironment() {
  const python = await findExecutable(process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]);
  const [managedWhisper, bundledFfmpeg, whisperCpp] = await Promise.all([
    managedWhisperReady(),
    managedFfmpegPath(),
    findExecutable(["whisper-cli", "whisper-cpp"])
  ]);
  const systemFfmpeg = bundledFfmpeg ? undefined : await findExecutable(["ffmpeg"]);
  return {
    paths: {
      whisperCpp,
      python,
      ffmpeg: bundledFfmpeg || systemFfmpeg
    },
    runtimes: {
      managedWhisper,
      whisperCpp: Boolean(whisperCpp),
      python: Boolean(python),
      ffmpeg: Boolean(bundledFfmpeg || systemFfmpeg),
      fasterWhisper: await probePythonPackage(python, "faster_whisper"),
      mlxWhisper: process.platform === "darwin" ? await probePythonPackage(python, "mlx_whisper") : false
    }
  };
}

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

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

export function looksLikeWhisperModel(filePath, sizeBytes) {
  if (sizeBytes < 30_000_000) return false;
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath, extension).toLowerCase();
  if (extension === ".pt") {
    return /(whisper|tiny|base|small|medium|large|turbo)/.test(name);
  }
  return /(whisper|ggml)/.test(name);
}

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

async function scanLocalModels({ roots, modelDirectory }) {
  const models = [];
  const state = { visited: 0 };
  for (const root of Array.from(new Set([...roots, modelDirectory]))) {
    await scanDirectory(root, models, state);
  }
  return Array.from(new Map(models.map((item) => [item.path, item])).values())
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

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
    ...(!profile.options?.ffmpegPath && environment.paths.ffmpeg ? { ffmpegPath: environment.paths.ffmpeg } : {})
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

export async function listDownloadableModels(modelDirectory) {
  return Promise.all(catalog.map(async ({ url: _url, digest: _digest, digestAlgorithm: _algorithm, ...item }) => {
    const localPath = path.join(modelDirectory, item.fileName);
    const fileStat = await stat(localPath).catch(() => null);
    return {
      ...item,
      installed: Boolean(fileStat?.size),
      localPath: fileStat?.size ? localPath : undefined
    };
  }));
}

// Dedupe concurrent downloads of the same model and throttle progress events so
// a large model download does not flood the renderer with one IPC per ~16KB chunk.
const activeDownloads = new Map();

export async function downloadModel(modelId, modelDirectory, onProgress = () => {}) {
  if (activeDownloads.has(modelId)) return activeDownloads.get(modelId);
  const promise = doDownloadModel(modelId, modelDirectory, onProgress);
  activeDownloads.set(modelId, promise);
  try {
    return await promise;
  } finally {
    activeDownloads.delete(modelId);
  }
}

async function doDownloadModel(modelId, modelDirectory, onProgress = () => {}) {
  const item = catalog.find((candidate) => candidate.id === modelId);
  if (!item) throw new Error("未找到可下载的模型。");
  onProgress({ modelId, downloadedBytes: 0, totalBytes: item.sizeBytes, status: "preparing", message: "正在准备本地转写组件…" });
  await ensureManagedLocalRuntime();
  await mkdir(modelDirectory, { recursive: true });
  const target = path.join(modelDirectory, item.fileName);
  const temporary = `${target}.download`;
  const response = await fetch(item.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`模型下载失败：HTTP ${response.status}`);
  }
  const totalBytes = Number(response.headers.get("content-length")) || item.sizeBytes;
  const hash = createHash(item.digestAlgorithm);
  const file = await open(temporary, "w");
  let downloadedBytes = 0;
  let lastProgressAt = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      await file.write(buffer);
      hash.update(buffer);
      downloadedBytes += buffer.byteLength;
      // Throttle progress to at most once per 250ms to avoid IPC flooding.
      const now = Date.now();
      if (now - lastProgressAt >= 250 || downloadedBytes >= totalBytes) {
        lastProgressAt = now;
        onProgress({ modelId, downloadedBytes, totalBytes, status: "downloading", message: "正在下载模型…" });
      }
    }
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  onProgress({ modelId, downloadedBytes, totalBytes, status: "verifying", message: "正在校验模型完整性…" });
  const actualDigest = hash.digest("hex");
  if (actualDigest !== item.digest) {
    await unlink(temporary).catch(() => {});
    throw new Error("模型校验失败，下载文件已删除，请重试。");
  }
  await rename(temporary, target);
  onProgress({ modelId, downloadedBytes, totalBytes, status: "ready", message: "模型与转写组件已就绪。" });
  return describeModel(target, downloadedBytes);
}

export function describeLocalModel(filePath, sizeBytes = 0) {
  return describeModel(filePath, sizeBytes);
}
