export type SummaryTemplateId = 'general' | 'weekly' | 'interview' | 'retro';

export interface SummaryTemplate {
  id: SummaryTemplateId;
  label: string;
  description: string;
  guidance: string;
}

export const SUMMARY_TEMPLATES: SummaryTemplate[];
export const SUMMARY_TEMPLATE_IDS: SummaryTemplateId[];
export function summaryTemplateById(id?: string): SummaryTemplate;
