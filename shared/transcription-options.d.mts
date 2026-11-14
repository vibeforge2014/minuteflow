export type TranscriptionParameter = 'transcriptionLanguage' | 'initialPrompt' | 'temperature' | 'temperatureStep' | 'beamSize' | 'noSpeechThreshold' | 'logprobThreshold' | 'entropyThreshold';
export const decodingKeys: TranscriptionParameter[];
export const transcriptionKeys: TranscriptionParameter[];
export const parameterRanges: Record<string, [number, number, number]>;
export function transcriptionParamCapabilities(transport: string, options?: {executablePath?: string}): TranscriptionParameter[];
export function resolveTranscriptionLanguage(explicit?: string, options?: {transcriptionLanguage?: string}, globalLanguage?: string): string;
export function transcriptionDecodingOptions(profile: {transport: string; options?: object}): Record<string, number>;
export function whisperCliDecodingArgs(profile: {transport: string; options?: object}): string[];
export function pythonDecodingOptions(profile: {transport: string; options?: object}): Record<string, number | number[]>;
