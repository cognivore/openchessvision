import { initialModel } from "./core/model";
import { createRuntime } from "./core/runtime";
import type { Msg } from "./core/msg";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/js/pdf.worker.min.js";

declare global {
  interface Window {
    loadDebugPdf?: () => void;
    __ocvDispatch?: (msg: Msg) => void;
  }
}

// Expose debug loader globally so inline scripts can use it
window.loadDebugPdf = async () => {
  // Wait for dispatch to be available
  const waitForDispatch = (): Promise<(msg: Msg) => void> => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__ocvDispatch) {
          resolve(window.__ocvDispatch);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  };

  try {
    const dispatch = await waitForDispatch();
    const resp = await fetch("/api/debug-load");
    if (!resp.ok) {
      console.error("Debug load failed:", resp.status);
      return;
    }
    const data = await resp.json();
    console.log("[DEBUG] loadDebugPdf response:", data);
    dispatch({
      tag: "PdfOpened",
      pdfId: data.pdf_id,
      pages: data.pages,
      filename: data.filename,
      contentHash: data.content_hash,
    } as Msg);
  } catch (e) {
    console.error("Debug load error:", e);
  }
};

window.addEventListener("DOMContentLoaded", () => {
  const { dispatch } = createRuntime(initialModel);
  window.__ocvDispatch = dispatch;
});
