# Joi Android 方案 C 交付校验

Android 已同步桌面选定的 C「深绿版画」Joi 肖像与艺术字标：启动图标、启动背景、配对页和首页品牌区。仅修改视觉与素材生成管线，连接、配对和业务操作保持原样。

## APK

- [joi-android-0.1.0-arm64.apk](../../release-joi-mobile/joi-android-0.1.0-arm64.apk)
- 大小：58,776,305 bytes（56.05 MiB）。
- SHA-256：`FFD902CC981123050EAA92B58011C4A41AE0E0E4BEA6A88007ABA78753D2D7E6`
- 包名：`com.aimana.joi.remote`；版本：`0.1.0`，versionCode `1`。
- Flutter / Joi 原生运行库目标：ARM64；APK 包内确认存在 `libapp.so`、`libflutter.so` 和 `libjoi_remote.so` 的 arm64-v8a 版本。
- 签名：Android Debug 调试证书，APK Signature Scheme v2 验证通过；与旧 APK 的证书 SHA-256 相同。
- 证书 SHA-256：`1992dfbf30f40ad4216e92199ee7e302b2eb0e1c8387616f4c16fa88fbf9ccb2`
- 此 release 变体仍采用项目既有调试签名，适合手动侧载验收。
- 旧 APK 已保留在 `release-joi-mobile-previous-20261010-1454/`。

## 素材与预览

- [配对页](joi-android-pairing.png)、[首页](joi-android-home.png)：真实 Flutter 组件，390×844，使用合成控制器；未读取真实连接或任务数据。
- Flutter 头像与桌面 256px 头像字节一致；字标由桌面 SVG 派生为 228×144 透明 PNG，显示时随现有主题着色。
- 五套兼容图标尺寸：48、72、96、144、192px；五套自适应前景尺寸：108、162、216、324、432px。
- Android 8+ 使用自适应 XML、森林绿背景和留有裁切空间的前景。前景层为 108dp，肖像占 72dp，居中外留 18dp。参考 [Android 官方自适应图标规范](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)。
- 兼容图标通过位图重新编码，避免 Android PNG 资源压缩移除 ICC 配置后改变显示颜色；从最终 APK 提取的 10 张图标均与源图逐像素相同。
- APK 中的 Flutter 头像和字标与源码素材 SHA-256 相同；编译后的启动背景、自适应 XML 与资源引用核验通过。

## 构建与检查

- `npm run build:mobile:android`：完成 Android ARM64 原生库构建、Flutter 依赖解析、analyze、62 项测试和 release APK。
- 色彩编码校正后，再执行素材生成与 `flutter build apk --release --target-platform android-arm64`，成功；最终产物同步到上述交付路径。
- `npm run typecheck`、`npm run lint`、7 项品牌/打包/术语契约、架构边界和 diff 检查通过。
- 素材生成使用临时 Electron userData。未安装到真实手机，未执行真机配对；预览不作为真机连接验收。
- 本轮是 Android 品牌增量验证；桌面全量测试、覆盖率与 E2E 结果见同会话前轮 [桌面校验](joi-c-package-verification.md)，未重复执行桌面全量门禁。

构建入口自动同步桌面主图与移动素材；不需要手工维护两套头像。未提交或推送工作树修改。
