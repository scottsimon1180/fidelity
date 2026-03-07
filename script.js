(() => {
  "use strict";

  function isStandaloneMode() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function getViewportHeight() {
    if (window.visualViewport && Number.isFinite(window.visualViewport.height)) {
      return window.visualViewport.height;
    }
    return window.innerHeight;
  }

  function updateAppHeight() {
    const standalone = isStandaloneMode();

    document.documentElement.classList.toggle("mode-standalone", standalone);
    document.documentElement.classList.toggle("mode-browser", !standalone);
    document.documentElement.style.setProperty("--app-height", `${Math.round(getViewportHeight())}px`);
  }

  updateAppHeight();
  window.addEventListener("resize", updateAppHeight);
  window.addEventListener("orientationchange", updateAppHeight);
  window.addEventListener("pageshow", updateAppHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateAppHeight);
  }

  const app = document.getElementById("app");

  const pickBtnA = document.getElementById("pickBtnA");
  const pickBtnB = document.getElementById("pickBtnB");
  const fileInputA = document.getElementById("fileInputA");
  const fileInputB = document.getElementById("fileInputB");

  const fileSizeA = document.getElementById("fileSizeA");
  const fileResA = document.getElementById("fileResA");

  const fileSizeB = document.getElementById("fileSizeB");
  const fileResB = document.getElementById("fileResB");

  const statusText = document.getElementById("statusText");
  const percentText = document.getElementById("percentText");
  const barFill = document.getElementById("barFill");
  const rowsText = document.getElementById("rowsText");
  const pixelsScannedText = document.getElementById("pixelsScannedText");

  const divergentPercentValue = document.getElementById("divergentPercentValue");
  const divergentPixelsValue = document.getElementById("divergentPixelsValue");
  const convergentPercentValue = document.getElementById("convergentPercentValue");
  const convergentPixelsValue = document.getElementById("convergentPixelsValue");

  const compareBtn = document.getElementById("compareBtn");
  const resetBtn = document.getElementById("resetBtn");

  const diffView = document.getElementById("diffView");
  const diffStage = document.getElementById("diffStage");
  const diffCanvas = document.getElementById("diffCanvas");
  const diffPlaceholder = document.getElementById("diffPlaceholder");
  const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true, alpha: false });

  const fsModal = document.getElementById("fsModal");
  const fsCloseBtn = document.getElementById("fsCloseBtn");
  const fsWrapper = document.getElementById("fsWrapper");
  const fsCanvas = document.getElementById("fsCanvas");
  const fsCtx = fsCanvas.getContext("2d", { alpha: false });

  let imageStateA = null;
  let imageStateB = null;
  let isProcessing = false;
  let compareRunId = 0;

  const ROW_BATCH = 24;

  let matrixTransform = { x: 0, y: 0, scale: 1 };
  let initialPinchDistance = 0;
  let initialScale = 1;
  let lastPanPosition = { x: 0, y: 0 };

  pickBtnA.addEventListener("click", () => {
    if (!isProcessing) fileInputA.click();
  });

  pickBtnB.addEventListener("click", () => {
    if (!isProcessing) fileInputB.click();
  });

  fileInputA.addEventListener("change", async () => {
    if (isProcessing) return;
    const file = fileInputA.files?.[0] || null;
    imageStateA = await handleImageSelection(file, "A");
    updateCompactLayoutState();
    refreshCompareState();
    refreshIdleStatus();
  });

  fileInputB.addEventListener("change", async () => {
    if (isProcessing) return;
    const file = fileInputB.files?.[0] || null;
    imageStateB = await handleImageSelection(file, "B");
    updateCompactLayoutState();
    refreshCompareState();
    refreshIdleStatus();
  });

  compareBtn.addEventListener("click", async () => {
    if (!isProcessing && imageStateA && imageStateB) {
      await compareImages();
    }
  });

  resetBtn.addEventListener("click", () => {
    if (!isProcessing) resetAll();
  });

  diffView.addEventListener("click", () => {
    if (diffCanvas.width <= 1 || diffCanvas.height <= 1) return;
    openViewer();
  });

  diffView.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && diffCanvas.width > 1 && diffCanvas.height > 1) {
      e.preventDefault();
      openViewer();
    }
  });

  fsCloseBtn.addEventListener("click", closeViewer);

  fsModal.addEventListener("click", (e) => {
    if (e.target === fsModal) closeViewer();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fsModal.classList.contains("active")) {
      closeViewer();
    }
  });

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      if (diffCanvas.width > 1 && diffCanvas.height > 1) {
        updateDiffStageSize(diffCanvas.width, diffCanvas.height);
      } else {
        resetDiffStageSize();
      }
    });
    ro.observe(diffView);
  } else {
    window.addEventListener("resize", () => {
      if (diffCanvas.width > 1 && diffCanvas.height > 1) {
        updateDiffStageSize(diffCanvas.width, diffCanvas.height);
      } else {
        resetDiffStageSize();
      }
    });
  }

  async function handleImageSelection(file, which) {
    resetComparisonOutputs();

    if (!file) {
      revokeImageStateURL(which === "A" ? imageStateA : imageStateB);
      clearImageUI(which);
      return null;
    }

    try {
      revokeImageStateURL(which === "A" ? imageStateA : imageStateB);

      const loaded = await loadImageFromFile(file);
      setImageUI(which, file, loaded);

      return {
        file,
        img: loaded.img,
        url: loaded.url,
        width: loaded.img.naturalWidth,
        height: loaded.img.naturalHeight
      };
    } catch (error) {
      console.error(error);
      clearImageUI(which);
      setStatus("Failed to load image", "error");
      return null;
    }
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = async () => {
        try {
          if (typeof img.decode === "function") {
            await img.decode().catch(() => {});
          }

          if (!img.naturalWidth || !img.naturalHeight) {
            URL.revokeObjectURL(url);
            reject(new Error("Invalid image dimensions"));
            return;
          }

          resolve({ img, url });
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Image load failed"));
      };

      img.src = url;
    });
  }

  async function compareImages() {
    if (!imageStateA || !imageStateB || isProcessing) return;

    const thisRunId = ++compareRunId;
    isProcessing = true;
    setButtonsDuringProcessing(true);
    resetComparisonOutputs();

    const widthA = imageStateA.width;
    const heightA = imageStateA.height;
    const widthB = imageStateB.width;
    const heightB = imageStateB.height;

    if (widthA !== widthB || heightA !== heightB) {
      setStatus("Resolution mismatch", "error");
      percentText.textContent = "0%";
      barFill.style.width = "0%";
      rowsText.textContent = "0 / 0 rows";
      pixelsScannedText.textContent = "0 pixels";
      setResultsInactive();
      setIdleDiffCanvas();
      isProcessing = false;
      setButtonsDuringProcessing(false);
      refreshCompareState();
      return;
    }

    try {
      setStatus("Preparing comparison…");
      rowsText.textContent = `0 / ${heightA} rows`;
      pixelsScannedText.textContent = "0 pixels";

      const imageDataA = getImageDataFromImage(imageStateA.img);
      const imageDataB = getImageDataFromImage(imageStateB.img);

      const dataA = imageDataA.data;
      const dataB = imageDataB.data;

      const diffImage = new ImageData(widthA, heightA);
      const diffData = diffImage.data;

      const totalPixels = widthA * heightA;
      let differingPixels = 0;
      let y = 0;

      diffCanvas.width = widthA;
      diffCanvas.height = heightA;
      diffPlaceholder.style.display = "none";
      updateDiffStageSize(widthA, heightA);

      while (y < heightA) {
        if (thisRunId !== compareRunId) return;

        const batchEnd = Math.min(y + ROW_BATCH, heightA);

        for (; y < batchEnd; y++) {
          let rowIndex = y * widthA * 4;

          for (let x = 0; x < widthA; x++, rowIndex += 4) {
            const different =
              dataA[rowIndex] !== dataB[rowIndex] ||
              dataA[rowIndex + 1] !== dataB[rowIndex + 1] ||
              dataA[rowIndex + 2] !== dataB[rowIndex + 2] ||
              dataA[rowIndex + 3] !== dataB[rowIndex + 3];

            if (different) {
              differingPixels++;
              diffData[rowIndex] = 255;
              diffData[rowIndex + 1] = 0;
              diffData[rowIndex + 2] = 0;
              diffData[rowIndex + 3] = 255;
            } else {
              diffData[rowIndex] = 50;
              diffData[rowIndex + 1] = 215;
              diffData[rowIndex + 2] = 75;
              diffData[rowIndex + 3] = 255;
            }
          }
        }

        diffCtx.putImageData(diffImage, 0, 0);

        const scannedPixels = Math.min(y * widthA, totalPixels);
        const progress = totalPixels > 0 ? (scannedPixels / totalPixels) * 100 : 100;

        setStatus("Comparing pixels…");
        percentText.textContent = `${progress.toFixed(1)}%`;
        barFill.style.width = `${progress}%`;
        rowsText.textContent = `${y} / ${heightA} rows`;
        pixelsScannedText.textContent = `${formatNumber(scannedPixels)} pixels`;

        await nextFrame();
      }

      const convergentPixels = totalPixels - differingPixels;
      const divergentPercent = totalPixels === 0 ? 0 : (differingPixels / totalPixels) * 100;
      const convergentPercent = totalPixels === 0 ? 100 : (convergentPixels / totalPixels) * 100;

      if (differingPixels === 0) {
        setStatus("Perfect Match", "success");
      } else {
        setStatus("Differences found", "error");
      }

      percentText.textContent = "100%";
      barFill.style.width = "100%";
      rowsText.textContent = `${heightA} / ${heightA} rows`;
      pixelsScannedText.textContent = `${formatNumber(totalPixels)} pixels`;

      setResultsActive({
        divergentPercent: `${divergentPercent.toFixed(4)}%`,
        divergentPixels: `${formatNumber(differingPixels)} px`,
        convergentPercent: `${convergentPercent.toFixed(4)}%`,
        convergentPixels: `${formatNumber(convergentPixels)} px`
      });

      if (fsModal.classList.contains("active")) {
        syncFullscreenCanvas();
      }
    } catch (error) {
      console.error(error);
      setStatus("Comparison failed", "error");
      setResultsInactive();
      setIdleDiffCanvas();
    } finally {
      isProcessing = false;
      setButtonsDuringProcessing(false);
      refreshCompareState();
    }
  }

  function getImageDataFromImage(img) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function setImageUI(which, file, loaded) {
    const btn = which === "A" ? pickBtnA : pickBtnB;
    const sizeEl = which === "A" ? fileSizeA : fileSizeB;
    const resEl = which === "A" ? fileResA : fileResB;

    btn.classList.remove("empty");
    btn.classList.add("filled");

    const shortName = escapeHtml(shortenFilename(file.name));
    const label = which === "A" ? "Image A" : "Image B";
    const safeSrc = loaded.url.replace(/"/g, "&quot;");

    btn.innerHTML = `
      <span class="image-btn-inner">
        <span class="image-thumb">
          <img src="${safeSrc}" alt="">
        </span>
        <span class="image-btn-text">
          <span class="image-btn-main">${shortName}</span>
          <span class="image-btn-sub">${label}</span>
        </span>
      </span>
    `;

    sizeEl.textContent = formatBytes(file.size);
    resEl.textContent = `${loaded.img.naturalWidth} × ${loaded.img.naturalHeight}`;
    sizeEl.classList.remove("empty");
    resEl.classList.remove("empty");
  }

  function clearImageUI(which) {
    const btn = which === "A" ? pickBtnA : pickBtnB;
    const sizeEl = which === "A" ? fileSizeA : fileSizeB;
    const resEl = which === "A" ? fileResA : fileResB;

    btn.classList.remove("filled");
    btn.classList.add("empty");
    btn.innerHTML = `
      <span class="image-btn-inner">
        <span class="image-empty-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="1 1 21.96 22.05" preserveAspectRatio="xMidYMid meet">
            <path d="M5.31,22l13.33,0.05c2.2,0,3.32-1.11,3.32-3.28V5.33c0-2.17-1.11-3.28-3.32-3.28L5.31,2C3.11,2,2,3.11,2,5.28v13.44 C2,20.9,3.11,22,5.31,22z M5.34,20.49c-1.19,0-1.84-0.63-1.84-1.85V5.36c0-1.22,0.65-1.85,1.84-1.85l13.27,0.05 c1.17,0,1.83,0.64,1.83,1.85v13.28c0,1.23-0.66,1.85-1.83,1.85L5.34,20.49z M8.71,10.38c1.21,0,2.2-0.99,2.2-2.2 c0-1.21-0.99-2.21-2.2-2.21c-1.22,0-2.2,1-2.2,2.21C6.51,9.4,7.49,10.38,8.71,10.38z M4.43,21.06h14.83c1.52,0,2.24-1.08,2.24-2.98 l-5.23-6.17c-0.4-0.47-0.84-0.7-1.33-0.7c-0.49,0-0.91,0.22-1.32,0.68l-3.94,4.45l-1.62-1.87c-0.37-0.42-0.75-0.64-1.18-0.64 c-0.4,0-0.77,0.2-1.11,0.62L2.5,18.25C2.59,20.16,3.16,21.06,4.43,21.06z"/>
          </svg>
        </span>
        <span class="image-btn-text">
          <span class="image-btn-main">${which === "A" ? "Choose Image A" : "Choose Image B"}</span>
        </span>
      </span>
    `;

    sizeEl.textContent = "";
    resEl.textContent = "";
    sizeEl.classList.add("empty");
    resEl.classList.add("empty");
  }

  function updateCompactLayoutState() {
    if (imageStateA && imageStateB) {
      app.classList.add("compact-images");
    } else {
      app.classList.remove("compact-images");
    }
  }

  function refreshCompareState() {
    compareBtn.disabled = !(imageStateA && imageStateB) || isProcessing;
  }

  function setButtonsDuringProcessing(active) {
    pickBtnA.disabled = active;
    pickBtnB.disabled = active;
    compareBtn.disabled = active || !(imageStateA && imageStateB);
    resetBtn.disabled = active;
  }

  function clearStatusColor() {
    statusText.classList.remove("status-success", "status-error");
  }

  function setStatus(text, tone = "") {
    statusText.textContent = text;
    clearStatusColor();
    if (tone === "success") statusText.classList.add("status-success");
    if (tone === "error") statusText.classList.add("status-error");
  }

  function refreshIdleStatus() {
    if (isProcessing) return;

    if (imageStateA && imageStateB) {
      setStatus("Ready to compare");
    } else if (imageStateA || imageStateB) {
      setStatus("Select the second image");
    } else {
      setStatus("Waiting for images…");
    }
  }

  function setResultsInactive() {
    divergentPercentValue.textContent = "0%";
    divergentPixelsValue.textContent = "0 px";
    convergentPercentValue.textContent = "0%";
    convergentPixelsValue.textContent = "0 px";

    divergentPercentValue.classList.add("is-placeholder");
    divergentPixelsValue.classList.add("is-placeholder");
    convergentPercentValue.classList.add("is-placeholder");
    convergentPixelsValue.classList.add("is-placeholder");
  }

  function setResultsActive(values) {
    divergentPercentValue.textContent = values.divergentPercent;
    divergentPixelsValue.textContent = values.divergentPixels;
    convergentPercentValue.textContent = values.convergentPercent;
    convergentPixelsValue.textContent = values.convergentPixels;

    divergentPercentValue.classList.remove("is-placeholder");
    divergentPixelsValue.classList.remove("is-placeholder");
    convergentPercentValue.classList.remove("is-placeholder");
    convergentPixelsValue.classList.remove("is-placeholder");
  }

  function resetComparisonOutputs() {
    refreshIdleStatus();
    percentText.textContent = "0%";
    barFill.style.width = "0%";
    rowsText.textContent = "0 / 0 rows";
    pixelsScannedText.textContent = "0 pixels";
    setResultsInactive();
    setIdleDiffCanvas();
  }

  function setIdleDiffCanvas() {
    diffCanvas.width = 1;
    diffCanvas.height = 1;
    diffCtx.clearRect(0, 0, 1, 1);
    diffPlaceholder.style.display = "flex";
    resetDiffStageSize();
    clearFullscreenImage();
  }

  function resetAll() {
    compareRunId++;

    fileInputA.value = "";
    fileInputB.value = "";

    revokeImageStateURL(imageStateA);
    revokeImageStateURL(imageStateB);

    imageStateA = null;
    imageStateB = null;
    isProcessing = false;

    clearImageUI("A");
    clearImageUI("B");
    updateCompactLayoutState();
    resetComparisonOutputs();

    compareBtn.disabled = true;
    resetBtn.disabled = false;
    closeViewer();
  }

  function revokeImageStateURL(state) {
    if (state?.url) {
      URL.revokeObjectURL(state.url);
    }
  }

  function updateDiffStageSize(sourceWidth, sourceHeight) {
    const maxWidth = diffView.clientWidth;
    const maxHeight = diffView.clientHeight;

    if (!maxWidth || !maxHeight || !sourceWidth || !sourceHeight) {
      resetDiffStageSize();
      return;
    }

    const aspect = sourceWidth / sourceHeight;

    let fittedWidth = maxWidth;
    let fittedHeight = fittedWidth / aspect;

    if (fittedHeight > maxHeight) {
      fittedHeight = maxHeight;
      fittedWidth = fittedHeight * aspect;
    }

    diffStage.style.width = `${Math.max(1, Math.round(fittedWidth))}px`;
    diffStage.style.height = `${Math.max(1, Math.round(fittedHeight))}px`;
  }

  function resetDiffStageSize() {
    diffStage.style.width = "100%";
    diffStage.style.height = "100%";
  }

  function syncFullscreenCanvas() {
    if (diffCanvas.width <= 1 || diffCanvas.height <= 1) return;

    fsCanvas.width = diffCanvas.width;
    fsCanvas.height = diffCanvas.height;

    fsCtx.clearRect(0, 0, fsCanvas.width, fsCanvas.height);
    fsCtx.drawImage(diffCanvas, 0, 0);
  }

  function openViewer() {
    if (diffCanvas.width <= 1 || diffCanvas.height <= 1) return;

    syncFullscreenCanvas();
    fsModal.classList.add("active");
    fsModal.setAttribute("aria-hidden", "false");

    matrixTransform = { x: 0, y: 0, scale: 1 };
    applyTransform();
  }

  function closeViewer() {
    fsModal.classList.remove("active");
    fsModal.setAttribute("aria-hidden", "true");
    initialPinchDistance = 0;
    initialScale = 1;
    lastPanPosition = { x: 0, y: 0 };
    matrixTransform = { x: 0, y: 0, scale: 1 };
    applyTransform();
  }

  function clearFullscreenImage() {
    fsCanvas.width = 1;
    fsCanvas.height = 1;
    fsCtx.clearRect(0, 0, 1, 1);

    matrixTransform = { x: 0, y: 0, scale: 1 };
    applyTransform();
  }

  function applyTransform() {
    matrixTransform.scale = Math.max(1, Math.min(15, matrixTransform.scale));

    if (matrixTransform.scale === 1) {
      matrixTransform.x = 0;
      matrixTransform.y = 0;
    }

    fsWrapper.style.transform =
      `translate(${matrixTransform.x}px, ${matrixTransform.y}px) scale(${matrixTransform.scale})`;
  }

  fsModal.addEventListener("touchstart", (e) => {
    if (!fsModal.classList.contains("active")) return;

    if (e.touches.length === 2) {
      initialPinchDistance = Math.hypot(
        e.touches[0].pageX - e.touches[1].pageX,
        e.touches[0].pageY - e.touches[1].pageY
      );
      initialScale = matrixTransform.scale;
    } else if (e.touches.length === 1) {
      lastPanPosition = {
        x: e.touches[0].pageX,
        y: e.touches[0].pageY
      };
    }
  }, { passive: true });

  fsModal.addEventListener("touchmove", (e) => {
    if (!fsModal.classList.contains("active")) return;

    e.preventDefault();

    if (e.touches.length === 2) {
      const currentDistance = Math.hypot(
        e.touches[0].pageX - e.touches[1].pageX,
        e.touches[0].pageY - e.touches[1].pageY
      );

      if (initialPinchDistance > 0) {
        matrixTransform.scale = initialScale * (currentDistance / initialPinchDistance);
        applyTransform();
      }
    } else if (e.touches.length === 1 && matrixTransform.scale > 1) {
      const dx = e.touches[0].pageX - lastPanPosition.x;
      const dy = e.touches[0].pageY - lastPanPosition.y;

      matrixTransform.x += dx / matrixTransform.scale;
      matrixTransform.y += dy / matrixTransform.scale;

      lastPanPosition = {
        x: e.touches[0].pageX,
        y: e.touches[0].pageY
      };

      applyTransform();
    }
  }, { passive: false });

  function shortenFilename(name, front = 7, back = 8) {
    const str = String(name || "");
    if (str.length <= front + back + 3) return str;
    return `${str.slice(0, front)}...${str.slice(-back)}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exp);

    if (exp === 0) return `${value.toFixed(0)} ${units[exp]}`;
    if (value >= 100) return `${value.toFixed(0)} ${units[exp]}`;
    if (value >= 10) return `${value.toFixed(1)} ${units[exp]}`;
    return `${value.toFixed(2)} ${units[exp]}`;
  }

  function formatNumber(num) {
    return new Intl.NumberFormat("en-US").format(num);
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  resetAll();
})();