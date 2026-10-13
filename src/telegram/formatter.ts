import { marked } from "marked";

/**
 * Converts standard GitHub Flavored Markdown into Telegram-compatible HTML.
 * Strictly outputs only tags officially permitted by Telegram Bot API:
 * <b>, <i>, <u>, <s>, <code>, <pre>, <blockquote>, <a href="...">
 */
export function formatToTelegramHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return "";

  try {
    const rawHtml = marked.parse(markdown, { async: false, breaks: true }) as string;

    const formatted = rawHtml
      // Headers -> Bold text with clean spacing (using \b to avoid matching other tags)
      .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n<b>$1</b>\n\n")
      // Paragraphs -> replace with paragraph breaks (without eating <pre>!)
      .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
      // Lists (unordered and ordered)
      .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, "$1\n")
      .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, "$1\n")
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "• $1\n")
      // Formatting tags (Bold, Italic, Strikethrough)
      .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, "<b>$1</b>")
      .replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, "<b>$1</b>")
      .replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, "<i>$1</i>")
      .replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, "<i>$1</i>")
      .replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, "<s>$1</s>")
      .replace(/<strike\b[^>]*>([\s\S]*?)<\/strike>/gi, "<s>$1</s>")
      // Blockquotes (without matching <b>!)
      .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, "<blockquote>$1</blockquote>\n\n")
      // Horizontal rules and line breaks
      .replace(/<hr\s*\/?>/gi, "\n———\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Strip unsupported HTML elements (tables, divs, spans)
      .replace(/<\/?(div|span|table|thead|tbody|tr|td|th)\b[^>]*>/gi, "")
      // Entities cleanup
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      // Normalize excessive newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return formatted;
  } catch (err) {
    // If markdown parsing fails, fallback to simple escaped text
    return markdown
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

/**
 * Strips all HTML tags to produce pristine plain text fallback.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Splits formatted HTML into safe chunks within Telegram's 4096-character limit.
 */
export function chunkHtmlMessage(html: string, maxLen = 4000): string[] {
  if (html.length <= maxLen) return [html];

  const chunks: string[] = [];
  const paragraphs = html.split("\n\n");
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length <= maxLen) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) chunks.push(current);
      if (para.length > maxLen) {
        for (let i = 0; i < para.length; i += maxLen) {
          chunks.push(para.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = para;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
