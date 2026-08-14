export type MeetingStatus = "draft" | "recording" | "paused" | "complete" | "interrupted";
export type MeetingMode = "online" | "offline";
export type TranscriptStatus = "provisional" | "final" | "failed";
export type AudioTrackKind = "microphone" | "system" | "mixed";

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  speakerId: string;
  speakerName: string;
  text: string;
  status: TranscriptStatus;
  track: AudioTrackKind;
  confidence?: number;
}

export interface ActionItem {
  id: string;
  title: string;
  owner: string;
  dueDate: string;
  status: "todo" | "in_progress" | "done";
  done: boolean;
  evidenceSegmentIds?: string[];
}

export interface MeetingSummary {
  topics: string[];
  keyPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
  risks: string[];
  nextSteps: string[];
  updatedAt?: string;
  stale?: boolean;
  manualLocks?: string[];
}

export interface Meeting {
  id: string;
  title: string;
  scheduledAt: string;
  durationSeconds: number;
  status: MeetingStatus;
  mode: MeetingMode;
  favorite: boolean;
  participants: string[];
  tags: string[];
  goals: string[];
  notes: string[];
  notesMarkdown?: string;
  summary: MeetingSummary;
  transcript: TranscriptSegment[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ModelProfile {
  id?: string;
  name: string;
  kind: "llm" | "stt" | "diarization";
  transport: "openai-chat" | "openai-audio" | "ollama" | "whisper-cpp" | "whisper-python" | "faster-whisper" | "mlx-whisper" | "sherpa-onnx";
  baseUrl: string;
  model: string;
  secretId?: string;
  options: {
    timeoutMs?: number;
    executablePath?: string;
    pythonExecutablePath?: string;
    modelPath?: string;
    ffmpegPath?: string;
    segmentationModelPath?: string;
    embeddingModelPath?: string;
    clusteringThreshold?: number;
    apiFlavor?: "openai" | "new-api" | "anthropic" | "gemini";
    responseFormat?: "json" | "verbose_json" | "text";
    chatEndpoint?: string;
    transcriptionEndpoint?: string;
    headers?: Record<string, string>;
  };
  enabled: boolean;
}

export interface AudioChunk {
  data: ArrayBuffer;
  fileName: string;
  startMs: number;
  endMs: number;
  track: AudioTrackKind;
}

export interface TranscriptContext {
  language: string;
  glossary?: string[];
  previousText?: string;
}

export interface AudioAsset {
  filePath: string;
  durationMs?: number;
}

export interface PlaybackAsset {
  id: string;
  track: AudioTrackKind;
  originalName: string;
  durationMs?: number;
  url: string;
}

export interface DiarizationOptions {
  expectedSpeakers?: number;
  threshold?: number;
}

export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  speakerId: string;
}

export interface SummaryDeltaInput {
  title: string;
  goals: string[];
  notes: string[];
  transcript: TranscriptSegment[];
  previousSummary: MeetingSummary;
}

export type FinalSummaryInput = SummaryDeltaInput;
export type MeetingSummaryRevision = MeetingSummary;

export interface TranscriptionProvider {
  transcribe(chunk: AudioChunk, context: TranscriptContext): Promise<TranscriptSegment[]>;
}

export interface DiarizationProvider {
  diarize(audio: AudioAsset, options: DiarizationOptions): Promise<SpeakerTurn[]>;
}

export interface SummaryProvider {
  update(input: SummaryDeltaInput): Promise<MeetingSummaryRevision>;
  finalize(input: FinalSummaryInput): Promise<MeetingSummaryRevision>;
}

export interface CreateMeetingInput {
  title: string;
  scheduledAt?: string;
  mode: MeetingMode;
  participants: string[];
  goals: string[];
  tags?: string[];
}

export interface MeetingPreferences {
  summaryIntervalSeconds: number;
  defaultMode: MeetingMode;
  glossary: string[];
  retentionDays: number | null;
  onboardingCompleted: boolean;
  systemPermissionsCompleted: boolean;
  permissionsVersion: number;
}

export type SystemPermissionValue = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export interface SystemPermissionStatus {
  microphone: SystemPermissionValue;
  screen: SystemPermissionValue;
  systemAudioRequired: boolean;
  systemAudioPickerHint: boolean;
}

export interface LicenseStatus {
  state: "licensed" | "unlicensed" | "error";
  productId: string;
  customerEmail?: string;
  entitlementId?: string;
  activatedAt?: string;
  lastVerifiedAt?: string;
  offline: boolean;
  message?: string;
  verificationConfigured: boolean;
  checkoutConfigured: boolean;
  insecureStorage: boolean;
}

export interface MacUpdateInfo {
  schemaVersion: 1;
  version: string;
  platform: "darwin";
  architectures: string[];
  publishedAt: string;
  notes: string;
  downloadUrl: string;
  releasePageUrl: string;
  assetUrl: string;
  sha256: string;
  minimumSystemVersion: string;
}

export interface AppUpdateCheckResult {
  status: "idle" | "available" | "up-to-date" | "unsupported" | "error";
  currentVersion: string;
  checkedAt: string;
  message: string;
  update?: MacUpdateInfo;
}

export interface RecordingStartResult {
  sessionId: string;
  startedAt: number;
}

export interface LocalModelFile {
  path: string;
  name: string;
  format: string;
  engine: "whisper-cpp" | "whisper-python" | "faster-whisper" | "mlx-whisper";
  sizeBytes: number;
}

export interface LocalRuntimeDiscovery {
  whisperCpp?: boolean;
  managedWhisper?: boolean;
  python?: boolean;
  ffmpeg?: boolean;
  fasterWhisper?: boolean;
  mlxWhisper?: boolean;
}

export interface LocalModelScanResult {
  models: LocalModelFile[];
  runtimes: LocalRuntimeDiscovery;
}

export interface DownloadableModel {
  id: string;
  name: string;
  description: string;
  engine: "whisper-cpp" | "whisper-python" | "faster-whisper" | "mlx-whisper";
  format: string;
  sizeBytes: number;
  fileName: string;
  source: string;
  license: string;
  installed: boolean;
  localPath?: string;
}

export interface ModelDownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  status: "preparing" | "downloading" | "verifying" | "ready" | "error";
  message?: string;
}

export interface ImportCandidate {
  sourcePath: string;
  name: string;
  title: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  lastModifiedAt: string;
  durationMs?: number;
}

export type ImportStage = "copying" | "preparing" | "transcribing" | "diarizing" | "summarizing" | "complete";
export type ImportStatus = "queued" | "copying" | "preparing" | "transcribing" | "diarizing" | "summarizing" |
  "waiting_for_model" | "waiting_for_summary_model" | "waiting_for_audio_tool" | "complete" | "cancelled" | "failed";

export interface ImportJob {
  id: string;
  meetingId: string;
  type: "import";
  title: string;
  sourceName: string;
  status: ImportStatus;
  stage: ImportStage;
  progress: number;
  language: string;
  sttProfileId?: string;
  llmProfileId?: string;
  diarizationEnabled: boolean;
  autoSummarize: boolean;
  audioAssetId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingAPI {
  meetings: {
    list(query?: string, includeDeleted?: boolean): Promise<Meeting[]>;
    get(id: string): Promise<Meeting | null>;
    create(input: CreateMeetingInput): Promise<Meeting>;
    save(meeting: Meeting): Promise<Meeting>;
    delete(id: string): Promise<boolean>;
    restore(id: string): Promise<Meeting>;
  };
  recordings: {
    start(meetingId: string): Promise<RecordingStartResult>;
    append(payload: {
      meetingId: string;
      sessionId: string;
      track: AudioTrackKind;
      sequence: number;
      data: ArrayBuffer;
      mimeType?: string;
    }): Promise<{ ok: true }>;
    stop(payload: {
      meetingId: string;
      sessionId: string;
      durationSeconds: number;
    }): Promise<Record<string, string>>;
    abort(payload: { meetingId: string; sessionId: string }): Promise<{ ok: true }>;
    open(meetingId: string): Promise<{ path: string }>;
    assets(meetingId: string): Promise<PlaybackAsset[]>;
  };
  transcription: {
    processChunk(payload: {
      profileId: string;
      data: ArrayBuffer;
      fileName: string;
      language: string;
      startMs: number;
      endMs: number;
      track: AudioTrackKind;
      glossary?: string[];
    }): Promise<TranscriptSegment>;
  };
  summary: {
    generate(payload: {
      profileId?: string;
      final: boolean;
      input: {
        title: string;
        goals: string[];
        notes: string[];
        transcript: TranscriptSegment[];
        previousSummary: MeetingSummary;
      };
    }): Promise<MeetingSummary>;
  };
  models: {
    list(): Promise<ModelProfile[]>;
    save(profile: ModelProfile, apiKey?: string): Promise<ModelProfile>;
    test(profile: ModelProfile, apiKey?: string): Promise<{ ok: boolean; message: string }>;
    deleteSecret(secretId: string): Promise<void>;
    scanLocal(): Promise<LocalModelScanResult>;
    chooseLocal(): Promise<LocalModelFile | null>;
    catalog(): Promise<DownloadableModel[]>;
    download(modelId: string): Promise<LocalModelFile>;
    onDownloadProgress(callback: (progress: ModelDownloadProgress) => void): () => void;
  };
  notes: {
    importMarkdown(): Promise<{ filePath: string; content: string } | null>;
  };
  imports: {
    choose(): Promise<ImportCandidate[]>;
    fromDropped(files: File[]): Promise<ImportCandidate[]>;
    enqueue(items: ImportCandidate[], options: {
      sttProfileId?: string;
      llmProfileId?: string;
      language?: string;
      diarizationEnabled?: boolean;
      autoSummarize?: boolean;
    }): Promise<ImportJob[]>;
    list(): Promise<ImportJob[]>;
    retry(id: string): Promise<ImportJob>;
    cancel(id: string): Promise<ImportJob>;
    onJobUpdated(callback: (job: ImportJob) => void): () => void;
  };
  exports: {
    save(meeting: Meeting, format: string): Promise<{ canceled: boolean; filePath?: string }>;
  };
  preferences: {
    get(): Promise<MeetingPreferences>;
    save(preferences: MeetingPreferences): Promise<MeetingPreferences>;
  };
  licensing: {
    getStatus(refresh?: boolean): Promise<LicenseStatus>;
    activate(licenseKey: string): Promise<LicenseStatus>;
    deactivate(): Promise<LicenseStatus>;
    openCheckout(): Promise<{ opened: true }>;
  };
  updates: {
    getState(): Promise<AppUpdateCheckResult>;
    check(): Promise<AppUpdateCheckResult>;
    openDownload(): Promise<{ opened: true }>;
    onAvailable(callback: (result: AppUpdateCheckResult) => void): () => void;
  };
  system: {
    platform: "darwin" | "win32" | "linux" | "web";
    getPermissions(): Promise<SystemPermissionStatus>;
    requestMicrophone(): Promise<SystemPermissionValue>;
    openSettings(kind?: "microphone" | "screen"): Promise<void>;
    onSuspend(callback: () => void): () => void;
    onResume(callback: () => void): () => void;
  };
  window: {
    toggleMini(enabled: boolean): Promise<boolean>;
    onMiniChanged(callback: (enabled: boolean) => void): () => void;
  };
}

declare global {
  interface Window {
    meetingAPI?: MeetingAPI;
  }
}
