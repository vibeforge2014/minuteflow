export type HotwordDomainId = "software" | "ai" | "product" | "finance" | "business";

export interface DomainHotwordEntry {
  term: string;
  aliases?: string[];
  weight?: number;
}

export interface HotwordDomain {
  id: HotwordDomainId;
  label: string;
  triggers: string[];
  terms: DomainHotwordEntry[];
}

export const HOTWORD_DOMAINS: HotwordDomain[];
export const HOTWORD_DOMAIN_IDS: HotwordDomainId[];

export function detectHotwordDomains(options?: {
  title?: string;
  goals?: string[];
  notes?: string[];
  notesMarkdown?: string;
  transcript?: Array<{ status?: string; text?: string }>;
  selectedDomains?: string[];
  autoDetect?: boolean;
}): HotwordDomainId[];

export function collectDomainHotwords(
  domainIds?: string[],
  options?: { contextText?: string; maxTerms?: number }
): {
  terms: Array<{ term: string; weight: number; domainId: HotwordDomainId }>;
  aliases: Array<{ alias: string; canonical: string; domainId: HotwordDomainId; matchedInText: boolean }>;
};

export interface ParsedGlossaryEntry {
  term: string;
  aliases: string[];
}

export function parseGlossaryEntry(raw: string): ParsedGlossaryEntry | null;
export function formatGlossaryEntry(entry: { term: string; aliases?: string[] }): string;
