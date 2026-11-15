# Joi 品牌素材

用户确认采用 G3「肩侧回眸」微调版（`exec-cc667043-66bf-474e-9829-1557eeec5c6e`）：象牙肤色、低饱和香槟金短发与深绿版画刻线。桌面、Web 与 Android 品牌资源已统一替换；搭配既有定制小写艺术字标，保留“思考、安排、派发”。

- 头像：`src/renderer/joi-avatar.png`，256×256 PNG，以 44px 圆形显示。
- 字标：`src/renderer/joi-wordmark.svg`，定制弧线笔画，CSS mask 使用当前主题的森林绿。
- 展示组件：`src/renderer/JoiBrand.tsx`；窄侧栏沿用既有折叠规则。
- 选定原图：[G3 微调版](design/joi-avatar-g3-refined.png)；选型、原版对比与完整提示词见 [设计记录](design/joi-portrait-selection.md)。
- 应用图标源：`resources/branding/icon.svg`，嵌入同一张头像，1024×1024，圆角外透明；`npm run assets:icons` 生成 `resources/branding/icon.png` 与 `public/icon.png` 并同步渲染缓存。
- 窗口、托盘、favicon 与桌面安装包使用同一图标；侧栏使用原图的 256×256 缩小版本。
- 生图方式：内置 `imagegen`；原始生成图保留在工具默认输出目录，项目素材使用 Electron nativeImage 等比例缩小。
- 设计范围：侧栏品牌区与应用图标，业务交互保持原样。

## Android 品牌同步

- Flutter 素材：`apps/joi_mobile/assets/joi-portrait.png` 与 `joi-wordmark.png`；配对页和首页使用 `lib/joi_brand.dart`。
- Launcher：五套密度的 `ic_launcher.png` 和 `ic_launcher_foreground.png`；Android 8+ 的自适应 XML 使用森林绿背景与带裁切留白的前景。
- 生成器：`scripts/render-mobile-brand.cjs`，自动作为 Android 构建步骤运行；从桌面已批准素材派生，不重新生图。
- 原 C 版的 [配对页预览](design/joi-android-pairing.png)、[首页预览](design/joi-android-home.png)、[APK 校验](design/joi-android-c-package-verification.md) 作为历史记录保留，不能代表本次最终版的安装包验证。

## 素材验收

- BRAND-01：项目原图与用户确认的生成文件一致；256×256 头像及 SVG 内嵌的 1024×1024 人像均从该原图等比例缩小。
- BRAND-02：桌面图标保持 1024×1024、圆角外透明；Android 五档密度保留 72dp 人像、108dp 图层与四周 18dp 安全留白。
- BRAND-03：桌面图标与 Web favicon 字节一致，桌面头像与 Flutter 人像字节一致；Android launcher 使用同源图标派生，字标保持原样。

本次更新源素材并验证前端构建，未重新生成桌面安装包或 Android APK。

## 初始人像参考生成提示词（历史记录）

```text
Use case: stylized-concept. Asset type: production avatar portrait for a personal desktop assistant named joi, displayed inside a 44–48px circular crop. Create ONE square portrait, no text or lettering. Subject: the fictional holographic companion Joi from Blade Runner 2049, recognizable through her short dark brunette bob with soft bangs, expressive brown eyes, delicate face and gentle intelligent half-smile. A close-up head-and-shoulders portrait facing the viewer, eye contact, adult woman, modest dark clothing barely visible at the bottom. Visual treatment: polished cinematic digital illustration, natural human facial proportions, softly painted photographic detail rather than anime or cartoon. Warm luminous skin, subtle amber light on the face, a delicate cool teal holographic rim on the hair and shoulder edges, only a faint suggestion of transparent holographic light; keep the eyes and facial features crisp and fully opaque so they read when very small. Background: simple uniform deep forest green (#1c4635) matching the existing app brand, no city scene, no interface graphics. Composition: large centered face; complete hair silhouette comfortably inside a central circular safe area; top of hair around 10% from top, chin around 78% from top; slight shoulder silhouette, generous clean corner background outside the circular safe area. Premium, intimate and reassuring companion character. No frame, no circular border baked into the image, no logo, no watermark, no other figures, no busy scan lines, no sexualized pose. Output a square image suitable as a high-quality small profile avatar.
```
