import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function resultExportHtml(body: string, font: string): string {
  const content = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm], skipHtml: true,
    components: { img: () => createElement('span', null, '[图片]') }, children: body,
  }));
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><style>
  @font-face{font-family:JoiExport;src:url(data:font/ttf;base64,${font})}*{box-sizing:border-box}html,body{margin:0;background:white;color:#18241d;font-family:JoiExport,sans-serif;font-size:20px;line-height:1.65}main{padding:48px;width:1080px}p,pre,blockquote,table,li,a{overflow-wrap:anywhere;word-break:break-word}pre{white-space:pre-wrap;background:#f4f5f4;padding:16px}code{font-family:JoiExport,monospace}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #aaa;padding:8px}blockquote{border-left:4px solid #849d8c;padding-left:16px}a{color:#235e42}img{display:none}h1,h2,h3{break-after:avoid}tr{break-inside:avoid}@page{size:A4;margin:16mm}@media print{html,body{font-size:11pt}main{width:auto;padding:0}pre{white-space:pre-wrap}}
  </style></head><body><main>${content}</main></body></html>`;
}
