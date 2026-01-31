import { initialModel } from "./core/model";
import { createRuntime } from "./core/runtime";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/js/pdf.worker.min.js";

window.addEventListener("DOMContentLoaded", () => {
  createRuntime(initialModel);
});
