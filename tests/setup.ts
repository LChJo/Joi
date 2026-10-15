import "@testing-library/jest-dom/vitest";
beforeEach(async () => {
  if (expect.getState().testPath?.replaceAll("\\", "/").includes("/tests/renderer/")) {
    const { configureLocale } = await import("../src/renderer/i18n");
    configureLocale({ preference: "zh-CN", systemLanguages: ["zh-CN"] });
  }
});

// jsdom has no layout/scrolling implementation; real scrolling is covered in Electron.
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollIntoView = () => undefined;

afterEach(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
});
