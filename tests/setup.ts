import "@testing-library/jest-dom/vitest";

// jsdom has no layout/scrolling implementation; real scrolling is covered in Electron.
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollIntoView = () => undefined;

afterEach(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
});
