import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";

// import { onINP, onLCP, onCLS } from 'web-vitals';
// import { Metric } from "web-vitals";
// import { entries } from "idb-keyval";

// function sendToAnalytics(metric : Metric) {
//   const body = JSON.stringify({
//     name: metric.name,
//     value: metric.value,
//     id: metric.id,
//     entries: metric.entries,
//     navigationType: metric.navigationType,

//     // Include additional data as needed...
//   });
//   navigator.sendBeacon("http://localhost:3001/perf", body);
// }

// onINP(sendToAnalytics, {reportAllChanges: true});

// onLCP(sendToAnalytics, {reportAllChanges: true});

// onCLS(sendToAnalytics, {reportAllChanges: true});

let drawing = false;
let moveCounter = 0;

function send(metric: any) {
  navigator.sendBeacon(
    "http://localhost:3001/perf",
    JSON.stringify(metric)
  );
}

window.addEventListener("pointerdown", () => {
  drawing = true;
});

window.addEventListener("pointerup", () => {
  drawing = false;
});

window.addEventListener("pointermove", () => {
  if (!drawing) return;

  moveCounter++;

  // Sampling: nur jeden 5. Move messen
  if (moveCounter % 5 !== 0) return;

  const start = performance.now();

  requestAnimationFrame(() => {
    const end = performance.now();

    send({
      name: "stroke-delay",
      value: end - start,
      timestamp: Date.now()
    });
  });
});

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
