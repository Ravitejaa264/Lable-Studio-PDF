import { types, getParent } from "mobx-state-tree";
import { clamp } from "../../../utils/utilities";

export const PdfPageEntity = types
  .model("PdfPageEntity", {
    id: types.identifier,
    pageIndex: types.number, // 1-based page number
    pdfUrl: types.string,

    rotation: types.optional(types.number, 0),

    /**
     * Natural sizes of PDF Page (in PDF points, 72 DPI)
     * These are the actual PDF page dimensions
     */
    naturalWidth: types.optional(types.number, 1),
    naturalHeight: types.optional(types.number, 1),

    /**
     * Stage sizes (rendered canvas dimensions in pixels)
     */
    stageWidth: types.optional(types.number, 1),
    stageHeight: types.optional(types.number, 1),

    /**
     * Zoom Scale
     */
    zoomScale: types.optional(types.number, 1),

    /**
     * Coordinates of left top corner for zoom/pan
     */
    zoomingPositionX: types.optional(types.number, 0),
    zoomingPositionY: types.optional(types.number, 0),
  })
  .volatile(() => ({
    stageRatio: 1,
    // Container's sizes causing limits to calculate a scale factor
    containerWidth: 1,
    containerHeight: 1,

    stageZoom: 1,
    stageZoomX: 1,
    stageZoomY: 1,
    currentZoom: 1,

    /** PDF.js document proxy */
    pdfDocument: null,
    /** PDF.js page proxy */
    pdfPage: null,
    /** Rendered canvas for this page */
    renderedCanvas: null,
    /** Is PDF being loaded */
    loading: false,
    /** If error happened during load */
    error: false,
    /** Is page rendered and ready */
    pageLoaded: false,
    /** Render scale (DPI scaling for PDF.js) */
    renderScale: 2.0, // For better quality on high-DPI displays
  }))
  .views((self) => ({
    get parent() {
      return getParent(self, 2);
    },
  }))
  .actions((self) => ({
    setPdfDocument(doc) {
      self.pdfDocument = doc;
    },

    setPdfPage(page) {
      self.pdfPage = page;
    },

    setRenderedCanvas(canvas) {
      self.renderedCanvas = canvas;
    },

    setLoading(loading) {
      self.loading = loading;
    },

    setError(error) {
      self.error = error;
    },

    setPageLoaded(loaded) {
      self.pageLoaded = loaded;
    },

    setNaturalWidth(width) {
      self.naturalWidth = width;
    },

    setNaturalHeight(height) {
      self.naturalHeight = height;
    },

    setStageWidth(width) {
      self.stageWidth = width;
    },

    setStageHeight(height) {
      self.stageHeight = height;
    },

    setStageRatio(ratio) {
      self.stageRatio = ratio;
    },

    setContainerWidth(width) {
      self.containerWidth = width;
    },

    setContainerHeight(height) {
      self.containerHeight = height;
    },

    setStageZoom(zoom) {
      self.stageZoom = zoom;
    },

    setStageZoomX(zoom) {
      self.stageZoomX = zoom;
    },

    setStageZoomY(zoom) {
      self.stageZoomY = zoom;
    },

    setCurrentZoom(zoom) {
      self.currentZoom = zoom;
    },

    setZoomScale(zoomScale) {
      self.zoomScale = zoomScale;
    },

    setZoomingPositionX(x) {
      self.zoomingPositionX = x;
    },

    setZoomingPositionY(y) {
      self.zoomingPositionY = y;
    },

    setRotation(angle) {
      self.rotation = angle;
    },
  }));

