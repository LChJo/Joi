# 离线导出字体

Noto Sans SC，来源：Google Fonts 的 `ofl/notosanssc/NotoSansSC[wght].ttf`。
源地址：https://github.com/google/fonts/tree/main/ofl/notosanssc

使用 fontTools `instantiateVariableFont(font, {'wght': 400})` 固定为常规字重，供 Electron 与 Android 离线 PDF/PNG 排版使用；Android 资产副本保持相同字节。
许可随附 `OFL.txt`（SIL Open Font License 1.1）。不请求在线字体或外部图片。
