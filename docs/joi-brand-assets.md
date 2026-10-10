# Joi 品牌素材

用户确认采用 C「深绿版画」：象牙色刻线与森林绿底的拟人化 Joi 头像，搭配定制小写艺术字标，保留“思考、安排、派发”。

- 头像：`src/renderer/joi-avatar.png`，256×256 PNG，以 44px 圆形显示。
- 字标：`src/renderer/joi-wordmark.svg`，定制弧线笔画，CSS mask 使用当前主题的森林绿。
- 展示组件：`src/renderer/JoiBrand.tsx`；窄侧栏沿用既有折叠规则。
- 选定原图：`docs/design/joi-avatar-option-c.png`；完整提示词与候选预览见 [设计记录](design/joi-avatar-options.md)。
- 应用图标源：`resources/branding/icon.svg`，嵌入同一张头像，1024×1024，圆角外透明；`npm run assets:icons` 生成 `resources/branding/icon.png` 与 `public/icon.png` 并同步渲染缓存。
- 窗口、托盘、favicon 与桌面安装包使用同一图标；侧栏使用原图的 256×256 缩小版本。
- 生图方式：内置 `imagegen`；原始生成图保留在工具默认输出目录，项目素材使用 Electron nativeImage 等比例缩小。
- 设计范围：侧栏品牌区与应用图标，业务交互保持原样。

## Android 品牌同步

- Flutter 素材：`apps/joi_mobile/assets/joi-portrait.png` 与 `joi-wordmark.png`；配对页和首页使用 `lib/joi_brand.dart`。
- Launcher：五套密度的 `ic_launcher.png` 和 `ic_launcher_foreground.png`；Android 8+ 的自适应 XML 使用森林绿背景与带裁切留白的前景。
- 生成器：`scripts/render-mobile-brand.cjs`，自动作为 Android 构建步骤运行；从桌面已批准素材派生，不重新生图。
- [配对页预览](design/joi-android-pairing.png)、[首页预览](design/joi-android-home.png)、[APK 校验](design/joi-android-c-package-verification.md)。

## 初始人像参考生成提示词

```text
Use case: stylized-concept. Asset type: production avatar portrait for a personal desktop assistant named joi, displayed inside a 44–48px circular crop. Create ONE square portrait, no text or lettering. Subject: the fictional holographic companion Joi from Blade Runner 2049, recognizable through her short dark brunette bob with soft bangs, expressive brown eyes, delicate face and gentle intelligent half-smile. A close-up head-and-shoulders portrait facing the viewer, eye contact, adult woman, modest dark clothing barely visible at the bottom. Visual treatment: polished cinematic digital illustration, natural human facial proportions, softly painted photographic detail rather than anime or cartoon. Warm luminous skin, subtle amber light on the face, a delicate cool teal holographic rim on the hair and shoulder edges, only a faint suggestion of transparent holographic light; keep the eyes and facial features crisp and fully opaque so they read when very small. Background: simple uniform deep forest green (#1c4635) matching the existing app brand, no city scene, no interface graphics. Composition: large centered face; complete hair silhouette comfortably inside a central circular safe area; top of hair around 10% from top, chin around 78% from top; slight shoulder silhouette, generous clean corner background outside the circular safe area. Premium, intimate and reassuring companion character. No frame, no circular border baked into the image, no logo, no watermark, no other figures, no busy scan lines, no sexualized pose. Output a square image suitable as a high-quality small profile avatar.
```
