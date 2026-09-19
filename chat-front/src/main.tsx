import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Queue-flushing service worker (no fetch handler, no caching): see public/sw.js
void import("./services/backgroundSync").then((m) => m.registerBackgroundSync());
