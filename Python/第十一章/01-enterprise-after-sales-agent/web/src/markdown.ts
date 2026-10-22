import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(value: string) {
  const html = marked.parse(value || "") as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}
