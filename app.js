"use strict";

const fileInput = document.querySelector("#file-input");
const openButton = document.querySelector("#open-button");
const emptyOpenButton = document.querySelector("#empty-open-button");
const saveButton = document.querySelector("#save-button");
const drawToolButton = document.querySelector("#draw-tool");
const textToolButton = document.querySelector("#text-tool");
const undoButton = document.querySelector("#undo-button");
const previousPageButton = document.querySelector("#previous-page");
const nextPageButton = document.querySelector("#next-page");
const zoomOutButton = document.querySelector("#zoom-out");
const zoomInButton = document.querySelector("#zoom-in");
const inkColorInput = document.querySelector("#ink-color");
const inkSizeInput = document.querySelector("#ink-size");
const documentName = document.querySelector("#document-name");
const currentPageLabel = document.querySelector("#current-page");
const totalPagesLabel = document.querySelector("#total-pages");
const zoomLabel = document.querySelector("#zoom-value");
const pageStage = document.querySelector("#page-stage");
const pageWrap = document.querySelector("#page-wrap");
const emptyState = document.querySelector("#empty-state");
const pdfCanvas = document.querySelector("#pdf-canvas");
const annotationCanvas = document.querySelector("#annotation-canvas");
const statusMessage = document.querySelector("#status-message");
const modeHint = document.querySelector("#mode-hint");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

const pdfContext = pdfCanvas.getContext("2d");
const annotationContext = annotationCanvas.getContext("2d");
const annotationsByPage = new Map();
let pdfDocument = null;
let originalPdfBytes = null;
let sourceFileName = "";
let currentPageNumber = 1;
let viewport = null;
let renderTask = null;
let renderSequence = 0;
let isRendering = false;
let activeStroke = null;
let activeTextEditor = null;
let mode = "draw";
let zoomScale = 1;
let fitToWidth = true;

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("is-error", isError);
}

function currentAnnotations() {
  if (!annotationsByPage.has(currentPageNumber)) {
    annotationsByPage.set(currentPageNumber, []);
  }
  return annotationsByPage.get(currentPageNumber);
}

function updateControls() {
  const hasDocument = Boolean(pdfDocument);
  const annotations = currentAnnotations();
  saveButton.disabled = !hasDocument;
  previousPageButton.disabled = !hasDocument || currentPageNumber <= 1;
  nextPageButton.disabled = !hasDocument || currentPageNumber >= pdfDocument.numPages;
  zoomOutButton.disabled = !hasDocument || zoomScale <= 0.5;
  zoomInButton.disabled = !hasDocument || zoomScale >= 2.5;
  undoButton.disabled = !hasDocument || (annotations.length === 0 && !activeStroke);
  currentPageLabel.textContent = hasDocument ? String(currentPageNumber) : "—";
  totalPagesLabel.textContent = hasDocument ? String(pdfDocument.numPages) : "—";
  zoomLabel.textContent = `${Math.round(zoomScale * 100)}%`;
  annotationCanvas.style.pointerEvents = isRendering ? "none" : "auto";
}

function setMode(nextMode) {
  mode = nextMode;
  const isDraw = mode === "draw";
  drawToolButton.classList.toggle("is-active", isDraw);
  drawToolButton.setAttribute("aria-pressed", String(isDraw));
  textToolButton.classList.toggle("is-active", !isDraw);
  textToolButton.setAttribute("aria-pressed", String(!isDraw));
  annotationCanvas.style.cursor = isDraw ? "crosshair" : "text";
  modeHint.textContent = isDraw
    ? "Draw mode · Use your finger, stylus, or mouse"
    : "Text mode · Tap or click on the page to type";
}

function getCanvasPoint(event) {
  const bounds = annotationCanvas.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
    width: bounds.width,
    height: bounds.height
  };
}

function paintAnnotations() {
  if (!viewport) return;
  const bounds = annotationCanvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const pixelRatio = window.devicePixelRatio || 1;
  annotationContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  annotationContext.clearRect(0, 0, bounds.width, bounds.height);

  for (const annotation of currentAnnotations()) {
    if (annotation.type === "stroke") {
      const points = annotation.points.map(point => ({
        x: point.x * bounds.width,
        y: point.y * bounds.height
      }));
      if (points.length === 0) continue;
      annotationContext.beginPath();
      annotationContext.strokeStyle = annotation.color;
      annotationContext.fillStyle = annotation.color;
      annotationContext.lineWidth = annotation.width * viewport.scale;
      annotationContext.lineCap = "round";
      annotationContext.lineJoin = "round";
      annotationContext.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        annotationContext.lineTo(points[index].x, points[index].y);
      }
      if (points.length === 1) {
        annotationContext.arc(
          points[0].x,
          points[0].y,
          annotationContext.lineWidth / 2,
          0,
          Math.PI * 2
        );
        annotationContext.fill();
      } else {
        annotationContext.stroke();
      }
    } else if (annotation.type === "text") {
      const x = annotation.x * bounds.width;
      const y = annotation.y * bounds.height;
      annotationContext.fillStyle = annotation.color;
      annotationContext.font = `${annotation.size * viewport.scale}px Arial, sans-serif`;
      annotationContext.textBaseline = "top";
      annotation.text.split("\n").forEach((line, index) => {
        annotationContext.fillText(line, x, y + index * annotation.size * viewport.scale * 1.2);
      });
    }
  }

  if (activeStroke) {
    annotationContext.beginPath();
    annotationContext.strokeStyle = activeStroke.color;
    annotationContext.fillStyle = activeStroke.color;
    annotationContext.lineWidth = activeStroke.width * viewport.scale;
    annotationContext.lineCap = "round";
    annotationContext.lineJoin = "round";
    const bounds = annotationCanvas.getBoundingClientRect();
    const firstPoint = {
      x: activeStroke.points[0].x * bounds.width,
      y: activeStroke.points[0].y * bounds.height
    };
    annotationContext.moveTo(firstPoint.x, firstPoint.y);
    for (let index = 1; index < activeStroke.points.length; index += 1) {
      annotationContext.lineTo(
        activeStroke.points[index].x * bounds.width,
        activeStroke.points[index].y * bounds.height
      );
    }
    if (activeStroke.points.length === 1) {
      annotationContext.arc(
        firstPoint.x,
        firstPoint.y,
        annotationContext.lineWidth / 2,
        0,
        Math.PI * 2
      );
      annotationContext.fill();
    } else {
      annotationContext.stroke();
    }
  }
}

async function renderCurrentPage() {
  if (!pdfDocument) return;
  const sequence = ++renderSequence;
  isRendering = true;
  updateControls();
  if (renderTask) {
    renderTask.cancel();
    renderTask = null;
  }

  try {
    const page = await pdfDocument.getPage(currentPageNumber);
    if (sequence !== renderSequence) return;
    const baseViewport = page.getViewport({ scale: 1 });
    if (fitToWidth) {
      const availableWidth = Math.max(250, pageStage.clientWidth - 48);
      zoomScale = Math.max(0.5, Math.min(1.5, availableWidth / baseViewport.width));
    }

    viewport = page.getViewport({ scale: zoomScale });
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    pageWrap.style.width = `${width}px`;
    pageWrap.style.height = `${height}px`;
    pdfCanvas.width = Math.ceil(width * pixelRatio);
    pdfCanvas.height = Math.ceil(height * pixelRatio);
    pdfCanvas.style.width = `${width}px`;
    pdfCanvas.style.height = `${height}px`;
    annotationCanvas.width = pdfCanvas.width;
    annotationCanvas.height = pdfCanvas.height;
    annotationCanvas.style.width = `${width}px`;
    annotationCanvas.style.height = `${height}px`;
    pdfContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const task = page.render({
      canvasContext: pdfContext,
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0]
    });
    renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      if (error.name === "RenderingCancelledException") return;
      throw error;
    } finally {
      if (renderTask === task) renderTask = null;
    }
    if (sequence !== renderSequence) return;

    emptyState.hidden = true;
    pageWrap.hidden = false;
    paintAnnotations();
  } finally {
    if (sequence === renderSequence) {
      isRendering = false;
      updateControls();
    }
  }
}

function normalizedPoint(x, y, width, height) {
  return {
    x: Math.min(1, Math.max(0, x / width)),
    y: Math.min(1, Math.max(0, y / height))
  };
}

function beginStroke(event) {
  if (!pdfDocument || isRendering || mode !== "draw" || event.button !== 0) return;
  event.preventDefault();
  annotationCanvas.setPointerCapture(event.pointerId);
  const point = getCanvasPoint(event);
  activeStroke = {
    type: "stroke",
    color: inkColorInput.value,
    width: Number(inkSizeInput.value),
    points: [normalizedPoint(point.x, point.y, point.width, point.height)]
  };
  activeStroke.previewPoint = { x: point.x, y: point.y };
  updateControls();
  paintAnnotations();
}

function continueStroke(event) {
  if (!activeStroke) return;
  event.preventDefault();
  const point = getCanvasPoint(event);
  activeStroke.points.push(normalizedPoint(point.x, point.y, point.width, point.height));
  activeStroke.previewPoint = { x: point.x, y: point.y };
  paintAnnotations();
}

function finishStroke(event) {
  if (!activeStroke) return;
  if (annotationCanvas.hasPointerCapture(event.pointerId)) {
    annotationCanvas.releasePointerCapture(event.pointerId);
  }
  delete activeStroke.previewPoint;
  currentAnnotations().push(activeStroke);
  activeStroke = null;
  updateControls();
  paintAnnotations();
  setStatus("Mark added.");
}

function commitTextEditor() {
  if (!activeTextEditor) return;
  const editor = activeTextEditor.element;
  const editorPosition = activeTextEditor;
  activeTextEditor = null;
  const text = editor.value.trim();
  if (text) {
    const bounds = annotationCanvas.getBoundingClientRect();
    currentAnnotations().push({
      type: "text",
      x: editorPosition.x / bounds.width,
      y: editorPosition.y / bounds.height,
      text,
      color: editorPosition.color,
      size: 18
    });
  }
  editor.remove();
  paintAnnotations();
  updateControls();
  if (text) setStatus("Text added.");
}

function cancelTextEditor() {
  if (!activeTextEditor) return;
  const editor = activeTextEditor.element;
  activeTextEditor = null;
  editor.remove();
  updateControls();
}

function placeTextEditor(event) {
  if (!pdfDocument || isRendering || mode !== "text" || event.target !== annotationCanvas) return;
  const point = getCanvasPoint(event);
  if (activeTextEditor) commitTextEditor();

  const editor = document.createElement("textarea");
  editor.className = "text-editor";
  editor.setAttribute("aria-label", "Text to add to the PDF");
  editor.rows = 1;
  editor.spellcheck = true;
  editor.style.left = `${Math.max(0, Math.min(point.x, point.width - 125))}px`;
  editor.style.top = `${Math.max(0, Math.min(point.y, point.height - 36))}px`;
  editor.style.color = inkColorInput.value;
  editor.style.fontSize = `${18 * viewport.scale}px`;
  pageWrap.append(editor);
  activeTextEditor = {
    element: editor,
    x: Number.parseFloat(editor.style.left),
    y: Number.parseFloat(editor.style.top),
    color: inkColorInput.value
  };
  editor.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commitTextEditor();
    } else if (event.key === "Escape") {
      cancelTextEditor();
    }
  });
  editor.addEventListener("blur", commitTextEditor, { once: true });
  editor.focus();
}

function colorToPdfColor(hex) {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return PDFLib.rgb(red, green, blue);
}

async function saveAnnotatedPdf() {
  if (!pdfDocument || !originalPdfBytes) return;
  commitTextEditor();
  setStatus("Preparing your annotated PDF…");
  saveButton.disabled = true;
  try {
    const outputPdf = await PDFLib.PDFDocument.load(originalPdfBytes);
    const pages = outputPdf.getPages();
    const helvetica = await outputPdf.embedFont(PDFLib.StandardFonts.Helvetica);

    for (const [pageNumber, annotations] of annotationsByPage.entries()) {
      const outputPage = pages[pageNumber - 1];
      if (!outputPage) continue;
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const pageViewport = pdfPage.getViewport({ scale: 1 });

      for (const annotation of annotations) {
        if (annotation.type === "stroke") {
          const points = annotation.points.map(point => {
            const [x, y] = pageViewport.convertToPdfPoint(
              point.x * pageViewport.width,
              point.y * pageViewport.height
            );
            return { x, y };
          });
          const color = colorToPdfColor(annotation.color);
          if (points.length === 1) {
            outputPage.drawCircle({
              x: points[0].x,
              y: points[0].y,
              size: annotation.width / 2,
              color
            });
          }
          for (let index = 1; index < points.length; index += 1) {
            outputPage.drawLine({
              start: points[index - 1],
              end: points[index],
              thickness: annotation.width,
              color
            });
          }
        } else if (annotation.type === "text") {
          const [x, topY] = pageViewport.convertToPdfPoint(
            annotation.x * pageViewport.width,
            annotation.y * pageViewport.height
          );
          outputPage.drawText(annotation.text, {
            x,
            y: topY - annotation.size,
            size: annotation.size,
            font: helvetica,
            color: colorToPdfColor(annotation.color),
            lineHeight: annotation.size * 1.2,
            maxWidth: Math.max(20, outputPage.getWidth() - x - 10)
          });
        }
      }
    }

    const savedBytes = await outputPdf.save();
    const blob = new Blob([savedBytes], { type: "application/pdf" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const baseName = sourceFileName.replace(/\.pdf$/i, "") || "document";
    link.href = downloadUrl;
    link.download = `${baseName}-annotated.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setStatus("Annotated PDF downloaded.");
  } catch (error) {
    setStatus(`Could not save the PDF: ${error.message}`, true);
  } finally {
    updateControls();
  }
}

async function openPdf(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    setStatus("Please choose a PDF file.", true);
    return;
  }
  setStatus("Opening PDF…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const loadedDocument = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    if (pdfDocument && renderTask) renderTask.cancel();
    pdfDocument = loadedDocument;
    originalPdfBytes = bytes;
    sourceFileName = file.name;
    currentPageNumber = 1;
    zoomScale = 1;
    fitToWidth = true;
    annotationsByPage.clear();
    documentName.textContent = sourceFileName;
    emptyState.hidden = true;
    pageWrap.hidden = false;
    updateControls();
    await renderCurrentPage();
    setStatus(`${pdfDocument.numPages} page${pdfDocument.numPages === 1 ? "" : "s"} ready.`);
  } catch (error) {
    pdfDocument = null;
    originalPdfBytes = null;
    pageWrap.hidden = true;
    emptyState.hidden = false;
    documentName.textContent = "No document open";
    updateControls();
    setStatus(`Could not open the PDF: ${error.message}`, true);
  }
}

function openFilePicker() {
  fileInput.click();
}

function changePage(nextPage) {
  if (!pdfDocument || nextPage < 1 || nextPage > pdfDocument.numPages) return;
  commitTextEditor();
  currentPageNumber = nextPage;
  updateControls();
  renderCurrentPage().catch(error => {
    setStatus(`Could not render page ${nextPage}: ${error.message}`, true);
  });
}

function changeZoom(delta) {
  if (!pdfDocument) return;
  commitTextEditor();
  fitToWidth = false;
  zoomScale = Math.max(0.5, Math.min(2.5, Math.round((zoomScale + delta) * 100) / 100));
  updateControls();
  renderCurrentPage().catch(error => {
    setStatus(`Could not change zoom: ${error.message}`, true);
  });
}

openButton.addEventListener("click", openFilePicker);
emptyOpenButton.addEventListener("click", openFilePicker);
fileInput.addEventListener("change", event => {
  openPdf(event.target.files[0]);
  event.target.value = "";
});
saveButton.addEventListener("click", saveAnnotatedPdf);
drawToolButton.addEventListener("click", () => setMode("draw"));
textToolButton.addEventListener("click", () => setMode("text"));
undoButton.addEventListener("click", () => {
  if (activeTextEditor) commitTextEditor();
  currentAnnotations().pop();
  paintAnnotations();
  updateControls();
  setStatus("Last mark undone.");
});
previousPageButton.addEventListener("click", () => changePage(currentPageNumber - 1));
nextPageButton.addEventListener("click", () => changePage(currentPageNumber + 1));
zoomOutButton.addEventListener("click", () => changeZoom(-0.15));
zoomInButton.addEventListener("click", () => changeZoom(0.15));
annotationCanvas.addEventListener("pointerdown", beginStroke);
annotationCanvas.addEventListener("pointermove", continueStroke);
annotationCanvas.addEventListener("pointerup", finishStroke);
annotationCanvas.addEventListener("pointercancel", finishStroke);
annotationCanvas.addEventListener("click", placeTextEditor);
window.addEventListener("resize", () => {
  if (!pdfDocument) return;
  if (activeTextEditor) commitTextEditor();
  renderCurrentPage().catch(error => {
    setStatus(`Could not resize the page: ${error.message}`, true);
  });
});
window.addEventListener("keydown", event => {
  const isTextInput = event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    openFilePicker();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveAnnotatedPdf();
  } else if (!isTextInput && event.key === "ArrowLeft") {
    changePage(currentPageNumber - 1);
  } else if (!isTextInput && event.key === "ArrowRight") {
    changePage(currentPageNumber + 1);
  }
});

setMode("draw");
updateControls();
