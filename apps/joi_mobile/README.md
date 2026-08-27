# Joi Android

Joi 的受限原生远程控制端。App 通过 `joi://pair` 二维码绑定桌面 Joi，使用 iroh 自动选择局域网直连或远程中继，只显示任务卡片并允许发送文字。

从仓库根目录构建：

```powershell
npm run build:mobile:android
```

release APK 输出到 `release-joi-mobile/joi-android-0.1.0-arm64.apk`。当前 release 变体使用调试签名，适合手动侧载验收；应用商店发布前必须替换为正式签名。
