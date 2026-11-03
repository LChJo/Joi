# Joi 素描头像候选方案

状态：用户看过预览后确认选择 C「深绿版画」，已应用到侧栏头像与应用图标。

由内置 imagegen 生成，参考当前 Joi 人像的身份特征与 [Hermes 官网头像](https://hermes-agent.nousresearch.com/)的黑白图形风格。

| 方案 | 方向 | 素材 |
|---|---|---|
| A | 铜版蚀刻、黑白对比 | [原图](joi-avatar-option-a.png) |
| B | 铅笔素描、柔和纸感 | [原图](joi-avatar-option-b.png) |
| C | 深绿版画、浅色刻线 | [原图](joi-avatar-option-c.png) |

[大图、圆形头像与 32px / 64px 图标对比](joi-avatar-options.html)

## 应用方式

侧栏使用 C 原图的 256×256 PNG，以圆形显示；窗口、托盘、favicon 与应用安装包使用同一头像的 1024×1024 圆角透明 PNG。权威 `resources/branding/icon.svg` 嵌入选定头像，渲染缓存已同步，重新打包时保持一致。A、B 作为设计候选保留。

## 最终生成提示词

### A

```text
Edit Image 1 into a brand-new illustrated avatar, preserving the identity, short dark brunette bob, soft bangs, gentle intelligent expression and recognizable facial proportions of Joi from Blade Runner 2049. Image 1 is the identity reference only; remove all photographic rendering, warm skin color and holographic lighting. Image 2 is the Hermes Agent avatar, STYLE reference only: borrow its strong monochrome silhouette, bold hair shapes, simplified facial planes and restrained engraved hatching, without copying its actual face, hairstyle, composition or brand. This is a production avatar and future desktop application icon for joi. ONE square image, no text, no wordmark, no letters, no borders, no surrounding interface, no watermark. Head-and-shoulders composition with a large face centered inside a circular safe region; complete hair with clear silhouette, a little room above the head, shoulders barely indicated. Design the eyes, hair and outer silhouette to remain recognizable at 32px. Adult woman, calm and approachable. Variant A — COPPERPLATE PORTRAIT. Elegant black ink portrait on a clean warm off-white paper background. Slight three-quarter turn facing right while looking gently toward the viewer. Crisp fine engraved contours, controlled cross-hatching and dark filled areas in the hair, pale face with clear clean highlights, a few expressive hand-drawn pencil-like lines. Aim for the artistic authority of an antique engraved portrait with the graphic clarity of the Hermes reference. The head must look human and alive, not a classical statue. Strong black-and-white contrast, medium detail, plenty of clean paper around the silhouette. No vintage ornament, no decorative emblem, no gray photographic gradients.
```

### B

```text
Edit Image 1 into a brand-new illustrated avatar, preserving the identity, short dark brunette bob, soft bangs, gentle intelligent expression and recognizable facial proportions of Joi from Blade Runner 2049. Image 1 is the identity reference only; remove all photographic rendering, warm skin color and holographic lighting. Image 2 is the Hermes Agent avatar, STYLE reference only: borrow its strong monochrome silhouette, bold hair shapes, simplified facial planes and restrained engraved hatching, without copying its actual face, hairstyle, composition or brand. This is a production avatar and future desktop application icon for joi. ONE square image, no text, no wordmark, no letters, no borders, no surrounding interface, no watermark. Head-and-shoulders composition with a large face centered inside a circular safe region; complete hair with clear silhouette, a little room above the head, shoulders barely indicated. Design the eyes, hair and outer silhouette to remain recognizable at 32px. Adult woman, calm and approachable. Variant B — GRAPHITE SKETCH. A delicate but clearly legible hand-drawn pencil portrait on clean warm off-white paper. Nearly front-facing, a slight natural head tilt, with the warm gentle half-smile and thoughtful eyes from the identity reference. Visible graphite strokes, softly layered hatching, a few relaxed sketch construction lines near the hair and shoulders, subtly textured paper. Short dark bob rendered with broad confident pencil shadows; expressive eyes and dark eyebrows; soft facial shading with generous untouched paper highlights. An intimate artist's portrait rather than a photograph, no colored skin, no neon, no plastic gradients, no anime, no statues. Simplify details enough to retain identity at icon size while maintaining the tactile charm of a real pencil drawing. Clean silhouette and a centered face suitable for circular avatar cropping.
```

### C

```text
Edit Image 1 into a brand-new illustrated avatar, preserving the identity, short dark brunette bob, soft bangs, gentle intelligent expression and recognizable facial proportions of Joi from Blade Runner 2049. Image 1 is the identity reference only; remove all photographic rendering, warm skin color and holographic lighting. Image 2 is the Hermes Agent avatar, STYLE reference only: borrow its strong monochrome silhouette, bold hair shapes, simplified facial planes and restrained engraved hatching, without copying its actual face, hairstyle, composition or brand. This is a production avatar and future desktop application icon for joi. ONE square image, no text, no wordmark, no letters, no borders, no surrounding interface, no watermark. Head-and-shoulders composition with a large face centered inside a circular safe region; complete hair with clear silhouette, a little room above the head, shoulders barely indicated. Design the eyes, hair and outer silhouette to remain recognizable at 32px. Adult woman, calm and approachable. Variant C — FOREST GREEN WOODCUT. A bold hand-drawn woodcut/linocut portrait rendered in warm ivory ink on a flat deep forest green background (#1c4635). Nearly front-facing with a slight three-quarter angle, centered, soft friendly half-smile and warm eyes. Strong graphic face planes, confident slightly imperfect carved contours and medium-weight engraved hatch lines. The face is predominantly warm ivory so it reads clearly at 32px, with forest-green strokes marking the eyebrows, eyes, nose and subtle shadows. Hair remains a dark forest silhouette with a restrained set of ivory curved carved strands, not a mass of tiny noisy lines. Dark modest collar only lightly indicated. Make it unmistakably a hand-crafted drawn portrait, not a photograph, not a 3D render, not a marble statue or anime. Use only two colors: deep forest green and warm ivory. Keep the background completely plain and dark green, a clean outline and circular-safe head placement, no decorative border, no flowers, no letter, no extra emblem. Refined human companion emblem, calm and memorable, with stronger small-size legibility than a fine pencil drawing.
```
