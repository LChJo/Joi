# Android 离线导出字体

- `NotoSansSC.ttf`：与桌面共用的常规字体，来源与转换见根目录 `resources/fonts/README.md`。
- `NotoSansSymbols2.ttf`：Google Fonts `ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf`，版本 2.008；原始 SHA-256 `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21`。
- `NotoEmoji.ttf`：Google Fonts `ofl/notoemoji/NotoEmoji[wght].ttf`，用 fontTools `instantiateVariableFont(font, {'wght': 400})` 固定常规字重；原始 SHA-256 `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`。

固定字重后 APK 资产 `NotoEmoji.ttf` SHA-256 为 `1ada997ccb67bf2404828e25528e5257d6db10c80287e77684abf6737a5d198f`。

来源分别为 https://github.com/google/fonts/tree/main/ofl/notosanssymbols2 和 https://github.com/google/fonts/tree/main/ofl/notoemoji 。保留各自的 OFL 许可和版权声明。字体随 APK 离线打包，运行时不请求在线字体。

导出使用单色符号和 Emoji；无法绘制的字符、ZWJ/肤色/旗帜等组合显示明确的 Unicode 码位。复制功能仍返回原始 Markdown。
