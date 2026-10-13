export interface ExtractedImage {
    alt: string;
    source: string;
    rawMatch: string;
}
/**
 * Extracts markdown images (![alt](path_or_url)) from markdown text.
 */
export declare function extractImages(markdown: string): {
    textWithoutImages: string;
    images: ExtractedImage[];
};
/**
 * Converts standard GitHub Flavored Markdown into Telegram-compatible HTML.
 * Strictly outputs only tags officially permitted by Telegram Bot API:
 * <b>, <i>, <u>, <s>, <code>, <pre>, <blockquote>, <a href="...">
 */
export declare function formatToTelegramHtml(markdown: string): string;
/**
 * Strips all HTML tags to produce pristine plain text fallback.
 */
export declare function stripHtml(html: string): string;
/**
 * Splits formatted HTML into safe chunks within Telegram's 4096-character limit.
 */
export declare function chunkHtmlMessage(html: string, maxLen?: number): string[];
