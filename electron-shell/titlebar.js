// titlebar.js — wires the custom macOS-style title bar to the main process.
// Runs in the renderer of titlebar.html; reaches the main process via the
// `piShell` object exposed by preload.js.

(function () {
  const iframe = document.getElementById("app-frame");
  const piUrl = (window.piShell && window.piShell.piUrl) || "http://localhost:14514";
  iframe.src = piUrl;

  document.getElementById("btn-close").addEventListener("click", () => {
    window.piShell.close();
  });

  document.getElementById("btn-minimize").addEventListener("click", () => {
    window.piShell.minimize();
  });

  document.getElementById("btn-maximize").addEventListener("click", () => {
    window.piShell.maximize();
  });

  // macOS convention: double-click the title bar (outside the buttons) to toggle maximize.
  const titlebar = document.getElementById("titlebar");
  titlebar.addEventListener("dblclick", (e) => {
    if (e.target === titlebar || e.target.classList.contains("titlebar-title")) {
      window.piShell.maximize();
    }
  });

  // Iframe load failure → swap to the error page data URL sent by main.
  if (window.piShell.onIframeError) {
    window.piShell.onIframeError((errorPageUrl) => {
      iframe.src = errorPageUrl;
    });
  }

  // Iframe retry → point the iframe back at the Pi Web URL.
  if (window.piShell.onIframeRetry) {
    window.piShell.onIframeRetry(() => {
      iframe.src = piUrl;
    });
  }

  // The error page (a data URL inside the iframe) can't reach the preload
  // directly, so it asks us to retry via postMessage.
  window.addEventListener("message", (e) => {
    if (e && e.data === "pi-retry") {
      iframe.src = piUrl;
    }
  });
})();
