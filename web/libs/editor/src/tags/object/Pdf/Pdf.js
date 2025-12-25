import { ff } from "@humansignal/core";
import { inject } from "mobx-react";
import { destroy, getRoot, getType, types } from "mobx-state-tree";

import PdfView from "../../../components/PdfView/PdfView";
import { customTypes } from "../../../core/CustomTypes";
import Registry from "../../../core/Registry";
import { AnnotationMixin } from "../../../mixins/AnnotationMixin";
import { IsReadyWithDepsMixin } from "../../../mixins/IsReadyMixin";
import { PdfRectRegionModel } from "../../../regions/PdfRectRegion";
import * as Tools from "../../../tools";
import ToolsManager from "../../../tools/Manager";
import { parseValue } from "../../../utils/data";
import {
  FF_DEV_3377,
  FF_DEV_3391,
  FF_DEV_3793,
  FF_ZOOM_OPTIM,
  isFF,
} from "../../../utils/feature-flags";
import { guidGenerator } from "../../../utils/unique";
import { clamp, isDefined } from "../../../utils/utilities";
import ObjectBase from "../Base";
import ProcessAttrsMixin from "../../../mixins/ProcessAttrs";
import { PdfEntityMixin } from "./PdfEntityMixin";
import { RELATIVE_STAGE_HEIGHT, RELATIVE_STAGE_WIDTH } from "../../../components/ImageView/Image";

const PDF_PRELOAD_COUNT = 3;
const ZOOM_INTENSITY = 0.009;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 100;
const MAX_ZOOM_CHANGE_PER_EVENT = 0.3;

/**
 * The `Pdf` tag displays a PDF document for annotation.
 * Supports multi-page documents with bounding box annotations.
 *
 * @example
 * <View>
 *   <Pdf name="pdf-1" value="$pdf_url" />
 * </View>
 * @name Pdf
 */
const TagAttrs = types.model({
  value: types.maybeNull(types.string),
  width: types.optional(types.string, "100%"),
  height: types.maybeNull(types.string),
  maxwidth: types.optional(types.string, "100%"),
  maxheight: types.optional(types.string, "calc(100vh - 194px)"),

  zoom: types.optional(types.boolean, true),
  negativezoom: types.optional(types.boolean, false),
  zoomby: types.optional(types.string, "1.1"),

  showlabels: types.optional(types.boolean, false),

  zoomcontrol: types.optional(types.boolean, true),
  rotatecontrol: types.optional(types.boolean, false),
  crosshair: types.optional(types.boolean, false),
  selectioncontrol: types.optional(types.boolean, true),

  horizontalalignment: types.optional(types.enumeration(["left", "center", "right"]), "left"),
  verticalalignment: types.optional(types.enumeration(["top", "center", "bottom"]), "top"),
  defaultzoom: types.optional(types.enumeration(["auto", "original", "fit"]), "fit"),
});

const PDF_CONSTANTS = {
  rectangleModel: "RectangleModel",
  rectangleLabelsModel: "RectangleLabelsModel",
  rectanglelabels: "rectanglelabels",
};

const Model = types
  .model({
    type: "pdf",

    sizeUpdated: types.optional(types.boolean, false),

    cursorPositionX: types.optional(types.number, 0),
    cursorPositionY: types.optional(types.number, 0),

    mode: types.optional(types.enumeration(["drawing", "viewing"]), "viewing"),

    regions: types.array(types.union(PdfRectRegionModel), []),

    drawingRegion: types.maybeNull(types.frozen()),
    selectionArea: types.maybeNull(types.frozen()),
  })
  .volatile(() => ({
    currentPage: 1, // 1-based page index
    supportSuggestions: true,
    containerRef: null,
    stageRef: null,
    pdfRef: null,
  }))
  .views((self) => ({
    get store() {
      return getRoot(self);
    },

    get parsedValue() {
      return parseValue(self.value, self.store.task.dataObj);
    },

    get currentSrc() {
      return self.parsedValue;
    },

    get hasStates() {
      const states = self.states();
      return states && states.length > 0;
    },

    get selectedRegions() {
      return self.regs.filter((region) => region.inSelection);
    },

    get selectedRegionsBBox() {
      let bboxCoords;

      self.selectedRegions.forEach((region) => {
        const regionBBox = region.bboxCoords;

        if (!regionBBox) return;

        if (bboxCoords) {
          bboxCoords = {
            left: Math.min(regionBBox?.left, bboxCoords.left),
            top: Math.min(regionBBox?.top, bboxCoords.top),
            right: Math.max(regionBBox?.right, bboxCoords.right),
            bottom: Math.max(regionBBox?.bottom, bboxCoords.bottom),
          };
        } else {
          bboxCoords = regionBBox;
        }
      });
      return bboxCoords;
    },

    get regionsInSelectionArea() {
      return self.regs.filter((region) => region.isInSelectionArea);
    },

    get selectedShape() {
      return self.regs.find((r) => r.selected);
    },

    get suggestions() {
      return self.annotation?.regionStore.suggestions.filter((r) => r.object === self) || [];
    },

    get useTransformer() {
      return self.getToolsManager().findSelectedTool()?.useTransformer === true;
    },

    get stageTranslate() {
      const { stageWidth: width, stageHeight: height } = self;

      return {
        0: { x: 0, y: 0 },
        90: { x: 0, y: height },
        180: { x: width, y: height },
        270: { x: width, y: 0 },
      }[self.rotation || 0];
    },

    get stageScale() {
      return self.zoomScale;
    },

    get layerZoomScalePosition() {
      return {
        scaleX: self.zoomScale,
        scaleY: self.zoomScale,
        x: self.zoomingPositionX + self.alignmentOffset.x,
        y: self.zoomingPositionY + self.alignmentOffset.y,
      };
    },

    get hasTools() {
      return !!self.getToolsManager().allTools()?.length;
    },

    get isSideways() {
      return ((self.rotation || 0) + 360) % 180 === 90;
    },

    get stageComponentSize() {
      if (self.isSideways) {
        return {
          width: self.stageHeight,
          height: self.stageWidth,
        };
      }
      return {
        width: self.stageWidth,
        height: self.stageHeight,
      };
    },

    get canvasSize() {
      if (self.isSideways) {
        return {
          width: isFF(FF_DEV_3377)
            ? self.naturalHeight * self.stageZoomX
            : Math.round(self.naturalHeight * self.stageZoomX),
          height: isFF(FF_DEV_3377)
            ? self.naturalWidth * self.stageZoomY
            : Math.round(self.naturalWidth * self.stageZoomY),
        };
      }

      return {
        width: isFF(FF_DEV_3377)
          ? self.naturalWidth * self.stageZoomX
          : Math.round(self.naturalWidth * self.stageZoomX),
        height: isFF(FF_DEV_3377)
          ? self.naturalHeight * self.stageZoomY
          : Math.round(self.naturalHeight * self.stageZoomY),
      };
    },

    get alignmentOffset() {
      const offset = { x: 0, y: 0 };

      if (isFF(FF_ZOOM_OPTIM)) {
        switch (self.horizontalalignment) {
          case "center": {
            offset.x = (self.containerWidth - self.canvasSize.width) / 2;
            break;
          }
          case "right": {
            offset.x = self.containerWidth - self.canvasSize.width;
            break;
          }
        }
        switch (self.verticalalignment) {
          case "center": {
            offset.y = (self.containerHeight - self.canvasSize.height) / 2;
            break;
          }
          case "bottom": {
            offset.y = self.containerHeight - self.canvasSize.height;
            break;
          }
        }
      }
      return offset;
    },

    get zoomBy() {
      return Number.parseFloat(self.zoomby);
    },

    get isDrawing() {
      return !!self.drawingRegion;
    },

    get maxScale() {
      return self.isSideways
        ? Math.min(self.containerWidth / self.naturalHeight, self.containerHeight / self.naturalWidth)
        : Math.min(self.containerWidth / self.naturalWidth, self.containerHeight / self.naturalHeight);
    },

    get coverScale() {
      return self.isSideways
        ? Math.max(self.containerWidth / self.naturalHeight, self.containerHeight / self.naturalWidth)
        : Math.max(self.containerWidth / self.naturalWidth, self.containerHeight / self.naturalHeight);
    },

    states() {
      return self.annotation.toNames.get(self.name);
    },

    activeStates() {
      const states = self.states();
      return states && states.filter((s) => s.isSelected && s.type.includes("labels"));
    },

    controlButton() {
      const names = self.states();
      if (!names || names.length === 0) return;

      let returnedControl = names[0];
      names.forEach((item) => {
        if (item.type === PDF_CONSTANTS.rectanglelabels) {
          returnedControl = item;
        }
      });
      return returnedControl;
    },

    get controlButtonType() {
      const name = self.controlButton();
      return getType(name).name;
    },

    // Get regions for current page only
    get regs() {
      return self.regions.filter((r) => r.pageIndex === self.currentPage);
    },
  }))
  .volatile((self) => ({
    manager: null,
  }))
  .actions((self) => {
    const manager = ToolsManager.getInstance({ name: self.name });
    const env = { manager, control: self, object: self };

    function createPdfPages() {
      if (!self.store.task || !self.parsedValue) return;

      // This will be populated when PDF loads
      // For now, just initialize with empty array
      // Actual page creation happens in PdfView component
    }

    function afterAttach() {
      if (ff.isActive(FF_DEV_3391) && !self.annotation) {
        return;
      }
      if (self.selectioncontrol) manager.addTool("MoveTool", Tools.Selection.create({}, env), "MoveTool");
      if (self.zoomcontrol) manager.addTool("ZoomPanTool", Tools.Zoom.create({}, env), "ZoomPanTool");
      if (self.rotatecontrol) manager.addTool("RotateTool", Tools.Rotate.create({}, env), "RotateTool");

      createPdfPages();
    }

    function afterResultCreated(region) {
      if (!region) return;
      if (region.classification) return;

      // Set page index for new regions
      if (region.setPageIndex) {
        region.setPageIndex(self.currentPage);
      }
    }

    function getToolsManager() {
      return manager;
    }

    function createDrawingRegion(areaValue, resultValue, control, dynamic) {
      const controlTag = self.annotation.names.get(control.name);

      const result = {
        from_name: controlTag,
        to_name: self,
        type: control.resultType,
        value: resultValue,
      };

      const areaRaw = {
        id: guidGenerator(),
        object: self,
        ...areaValue,
        results: [result],
        dynamic,
        pageIndex: self.currentPage, // PDF-specific: include current page index
      };

      self.drawingRegion = areaRaw;
      return self.drawingRegion;
    }

    function deleteDrawingRegion() {
      const { drawingRegion } = self;

      if (!drawingRegion) return;
      self.drawingRegion = null;
      destroy(drawingRegion);
    }

    function setCurrentPage(pageIndex) {
      // pageIndex is 1-based
      if (pageIndex === self.currentPage && self.currentPageEntity) return;
      self.currentPage = pageIndex;
      const pageEntity = self.findPageEntity(pageIndex);
      if (pageEntity) {
        self.currentPageEntity = pageEntity;
        // Update container size when page changes
        if (self.containerRef && pageEntity.naturalWidth && pageEntity.naturalHeight) {
          const { offsetWidth, offsetHeight } = self.containerRef;
          if (offsetWidth > 1 && offsetHeight > 1) {
            self.onResize(offsetWidth, offsetHeight);
          }
        }
      }
    }

    function setZoom(scale) {
      scale = clamp(scale, 1, Number.POSITIVE_INFINITY);
      self.currentZoom = scale;

      const maxScale = self.maxScale;
      const coverScale = self.coverScale;

      if (maxScale > 1) {
        if (scale < maxScale) {
          self.stageZoom = scale;
          self.zoomScale = 1;
        } else {
          self.stageZoom = maxScale;
          self.zoomScale = scale / maxScale;
        }
      } else {
        if (scale > maxScale) {
          self.stageZoom = maxScale;
          self.zoomScale = scale;
        } else {
          self.stageZoom = scale;
          self.zoomScale = 1;
        }
      }

      if (self.zoomScale > 1) {
        const z = Math.min(maxScale * self.zoomScale, coverScale);

        if (self.containerWidth / self.naturalWidth > self.containerHeight / self.naturalHeight) {
          self.stageZoomX = z;
          self.stageZoomY = self.stageZoom;
        } else {
          self.stageZoomX = self.stageZoom;
          self.stageZoomY = z;
        }
      } else {
        self.stageZoomX = self.stageZoom;
        self.stageZoomY = self.stageZoom;
      }
    }

    function setZoomPosition(x, y) {
      const [width, height] = isFF(FF_DEV_3377)
        ? [self.canvasSize.width, self.canvasSize.height]
        : [self.containerWidth, self.containerHeight];

      const [minX, minY] = [
        width - self.stageComponentSize.width * self.zoomScale,
        height - self.stageComponentSize.height * self.zoomScale,
      ];

      self.zoomingPositionX = clamp(x, minX, 0);
      self.zoomingPositionY = clamp(y, minY, 0);
    }

    function handleZoom(val, mouseRelativePos = { x: self.canvasSize.width / 2, y: self.canvasSize.height / 2 }, isEvent = false) {
      if (val) {
        const zoomScale = isEvent
          ? self.getInertialZoom(val)
          : val > 0
            ? self.currentZoom * self.zoomBy
            : self.currentZoom / self.zoomBy;

        if (self.negativezoom !== true && zoomScale <= 1) {
          self.setZoom(1);
          self.setZoomPosition(0, 0);
          self.updatePdfAfterZoom();
          return;
        }

        if (zoomScale <= 1) {
          self.setZoom(zoomScale);
          self.setZoomPosition(0, 0);
          self.updatePdfAfterZoom();
          return;
        }

        let stageScale = self.zoomScale;
        const mouseAbsolutePos = {
          x: (mouseRelativePos.x - self.zoomingPositionX) / stageScale,
          y: (mouseRelativePos.y - self.zoomingPositionY) / stageScale,
        };

        self.setZoom(zoomScale);
        stageScale = self.zoomScale;

        const zoomingPosition = {
          x: -(mouseAbsolutePos.x - mouseRelativePos.x / stageScale) * stageScale,
          y: -(mouseAbsolutePos.y - mouseRelativePos.y / stageScale) * stageScale,
        };

        self.setZoomPosition(zoomingPosition.x, zoomingPosition.y);
        self.updatePdfAfterZoom();
      }
    }

    function getInertialZoom(val) {
      const invert = getRoot(self).settings.invertedZoom ? 1 : -1;
      const invertedVal = val * invert;
      const zoomChange = Math.exp(invertedVal * ZOOM_INTENSITY);
      const limitedZoomChange = Math.max(
        1 - MAX_ZOOM_CHANGE_PER_EVENT,
        Math.min(1 + MAX_ZOOM_CHANGE_PER_EVENT, zoomChange),
      );
      return clamp(self.currentZoom * limitedZoomChange, MIN_ZOOM, MAX_ZOOM);
    }

    function updatePdfAfterZoom() {
      const { stageWidth, stageHeight } = self;
      self._recalculatePdfParams();

      if (stageWidth !== self.stageWidth || stageHeight !== self.stageHeight) {
        self._updateRegionsSizes({
          width: self.stageWidth,
          height: self.stageHeight,
          naturalWidth: self.naturalWidth,
          naturalHeight: self.naturalHeight,
        });
      }
    }

    function _recalculatePdfParams() {
      self.stageWidth = isFF(FF_DEV_3377)
        ? self.naturalWidth * self.stageZoom
        : Math.round(self.naturalWidth * self.stageZoom);
      self.stageHeight = isFF(FF_DEV_3377)
        ? self.naturalHeight * self.stageZoom
        : Math.round(self.naturalHeight * self.stageZoom);
    }

    function _updateRegionsSizes({ width, height, naturalWidth, naturalHeight }) {
      const _historyLength = self.annotation?.history?.history?.length;
      self.annotation.history.freeze();

      self.regions.forEach((shape) => {
        shape.updateImageSize?.(width / naturalWidth, height / naturalHeight, width, height);
      });
      self.drawingRegion?.updateImageSize?.(width / naturalWidth, height / naturalHeight, width, height);

      setTimeout(self.annotation.history.unfreeze, 0);

      if (_historyLength <= 1) {
        setTimeout(() => self.annotation?.reinitHistory(false), 0);
      }
    }

    function updatePdfSize(ev) {
      // This will be called when PDF page is rendered
      // Dimensions come from PDF.js page rendering
    }

    function onResize(width, height) {
      self._updatePdfSize({ width, height });
    }

    function _updatePdfSize({ width, height }) {
      if (self.naturalWidth === undefined) {
        return;
      }
      if (width > 1 && height > 1) {
        const prevWidth = self.canvasSize.width;
        const prevHeight = self.canvasSize.height;
        const prevStageZoom = self.stageZoom;
        const prevZoomScale = self.zoomScale;

        self.containerWidth = width;
        self.containerHeight = height;

        self.setZoom(self.currentZoom);
        self._recalculatePdfParams();

        const zoomChangeRatio = self.stageZoom / prevStageZoom;
        const scaleChangeRatio = self.zoomScale / prevZoomScale;
        const changeRatio = zoomChangeRatio * scaleChangeRatio;

        self.setZoomPosition(
          self.zoomingPositionX * changeRatio + (self.canvasSize.width / 2 - (prevWidth / 2) * changeRatio),
          self.zoomingPositionY * changeRatio + (self.canvasSize.height / 2 - (prevHeight / 2) * changeRatio),
        );
      }

      self.sizeUpdated = true;
      self._updateRegionsSizes({
        width: self.stageWidth,
        height: self.stageHeight,
        naturalWidth: self.naturalWidth,
        naturalHeight: self.naturalHeight,
      });
    }

    function addShape(shape) {
      self.regions.push(shape);
      self.annotation.addRegion(shape);
    }

    function setPointerPosition({ x, y }) {
      self.cursorPositionX = x;
      self.cursorPositionY = y;
    }

    function setMode(mode) {
      self.mode = mode;
    }

    function event(name, ev, screenX, screenY) {
      const [canvasX, canvasY] = self.fixZoomedCoords([screenX, screenY]);
      const x = self.canvasToInternalX(canvasX);
      const y = self.canvasToInternalY(canvasY);

      self.getToolsManager().event(name, ev.evt || ev, x, y, canvasX, canvasY);
    }

    function createSerializedResult(region, value) {
      const pageIndex = region.pageIndex ?? self.currentPage;
      const pageEntity = self.findPageEntity(pageIndex);

      const pdfDimension = {
        original_width: pageEntity?.naturalWidth || self.naturalWidth,
        original_height: pageEntity?.naturalHeight || self.naturalHeight,
        page_rotation: pageEntity?.rotation || 0,
        page_index: pageIndex,
      };

      return {
        ...pdfDimension,
        value,
      };
    }

    function setContainerRef(ref) {
      self.containerRef = ref;
    }

    function setStageRef(ref) {
      self.stageRef = ref;
      const currentTool = self.getToolsManager().findSelectedTool();
      currentTool?.updateCursor?.();
    }

    function setPdfRef(ref) {
      self.pdfRef = ref;
    }

    return {
      afterAttach,
      getToolsManager,
      afterResultCreated,
      createDrawingRegion,
      deleteDrawingRegion,
      setCurrentPage,
      setZoom,
      setZoomPosition,
      handleZoom,
      getInertialZoom,
      updatePdfAfterZoom,
      _recalculatePdfParams,
      _updateRegionsSizes,
      updatePdfSize,
      onResize,
      _updatePdfSize,
      addShape,
      setPointerPosition,
      setMode,
      event,
      createSerializedResult,
      setContainerRef,
      setStageRef,
      setPdfRef,
    };
  })
  .extend((self) => {
    let skipInteractions = false;

    return {
      views: {
        getSkipInteractions() {
          if (isFF(FF_ZOOM_OPTIM)) {
            if (skipInteractions) return true;

            const isLinkingMode = self.annotation.isLinkingMode;
            if (isLinkingMode) return false;

            const manager = self.getToolsManager();
            const tool = manager.findSelectedTool();
            const canInteractWithRegions = tool?.canInteractWithRegions;

            return !canInteractWithRegions;
          }
          const manager = self.getToolsManager();
          const isPanning = manager.findSelectedTool()?.toolName === "ZoomPanTool";
          return skipInteractions || isPanning;
        },
      },
      actions: {
        setSkipInteractions(value) {
          skipInteractions = value;
        },
        updateSkipInteractions(e) {
          const currentTool = self.getToolsManager().findSelectedTool();

          if (currentTool?.shouldSkipInteractions) {
            return self.setSkipInteractions(currentTool.shouldSkipInteractions(e));
          }
          self.setSkipInteractions(e.evt && (e.evt.metaKey || e.evt.ctrlKey));
        },
      },
    };
  });

const CoordsCalculations = types
  .model()
  .actions((self) => ({
    fixZoomedCoords([x, y]) {
      if (!self.stageRef) {
        return [x, y];
      }
      const p = self.stageRef.getAbsoluteTransform().copy().invert().point({ x, y });
      return [p.x, p.y];
    },

    zoomOriginalCoords([x, y]) {
      const p = self.stageRef.getAbsoluteTransform().point({ x, y });
      return [p.x, p.y];
    },
  }))
  .views((self) => ({
    get whRatio() {
      if (!isFF(FF_DEV_3793)) return 1;
      return self.stageWidth / self.stageHeight;
    },

    canvasToInternalX(n) {
      return (n / self.stageWidth) * RELATIVE_STAGE_WIDTH;
    },

    canvasToInternalY(n) {
      return (n / self.stageHeight) * RELATIVE_STAGE_HEIGHT;
    },

    internalToCanvasX(n) {
      return (n / RELATIVE_STAGE_WIDTH) * self.stageWidth;
    },

    internalToCanvasY(n) {
      return (n / RELATIVE_STAGE_HEIGHT) * self.stageHeight;
    },

    // PDF-specific: convert normalized coords to PDF page coords
    internalToPdfX(n) {
      const { naturalWidth } = self.currentPageEntity || {};
      if (!naturalWidth) return n;
      return (n / RELATIVE_STAGE_WIDTH) * naturalWidth;
    },

    internalToPdfY(n) {
      const { naturalHeight } = self.currentPageEntity || {};
      if (!naturalHeight) return n;
      return (n / RELATIVE_STAGE_HEIGHT) * naturalHeight;
    },

    pdfToInternalX(n) {
      const { naturalWidth } = self.currentPageEntity || {};
      if (!naturalWidth) return n;
      return (n / naturalWidth) * RELATIVE_STAGE_WIDTH;
    },

    pdfToInternalY(n) {
      const { naturalHeight } = self.currentPageEntity || {};
      if (!naturalHeight) return n;
      return (n / naturalHeight) * RELATIVE_STAGE_HEIGHT;
    },
  }));

const AbsoluteCoordsCalculations = CoordsCalculations.views(() => ({
  canvasToInternalX(n) {
    return n;
  },
  canvasToInternalY(n) {
    return n;
  },
  internalToCanvasX(n) {
    return n;
  },
  internalToCanvasY(n) {
    return n;
  },
}));

const PdfModel = types.compose(
  "PdfModel",
  TagAttrs,
  ObjectBase,
  ProcessAttrsMixin,
  AnnotationMixin,
  IsReadyWithDepsMixin,
  PdfEntityMixin,
  Model,
  isFF(FF_DEV_3793) ? CoordsCalculations : AbsoluteCoordsCalculations,
);

const HtxPdf = inject("store")(PdfView);

Registry.addTag("pdf", PdfModel, HtxPdf);
Registry.addObjectType(PdfModel);

export { PdfModel, HtxPdf };

