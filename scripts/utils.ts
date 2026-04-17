export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const pad = (n: number) => String(n).padStart(2, "0");
export const stripHtml = (s: string) => s.replaceAll(/<[^>]*>/g, " ").trim();
