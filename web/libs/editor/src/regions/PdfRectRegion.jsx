import Konva from "konva";
import { getRoot, isAlive, types } from "mobx-state-tree";
import { useContext } from "react";
import { Rect } from "react-konva";
import { ImageViewContext } from "../components/ImageView/ImageViewContext";
import { LabelOnRect } from "../components/ImageView/LabelOnRegion";
import Constants from "../core/Constants";
import { guidGenerator } from "../core/Helpers";
import Registry from "../core/Registry";
import { useRegionStyles } from "../hooks/useRegionColor";
import { AreaMixin } from "../mixins/AreaMixin";
import { KonvaRegionMixin } from "../mixins/KonvaRegion";
import NormalizationMixin from "../mixins/Normalization";
import RegionsMixin from "../mixins/Regions";
import { PdfModel } from "../tags/object/Pdf";
import { rotateBboxCoords } from "../utils/bboxCoords";
import { FF_DEV_3793, isFF } from "../utils/feature-flags";
import { createDragBoundFunc } from "../utils/image";
import { AliveRegion } from "./AliveRegion";
import { EditableRegion } from "./EditableRegion";
import { RegionWrapper } from "./RegionWrapper";
import { RELATIVE_STAGE_HEIGHT, RELATIVE_STAGE_WIDTH } from "../components/ImageView/Image";

/**
 * PDF Rectangle Region Model
 * Similar to RectRegion but with pageIndex support for multi-page PDFs
 */
const Model = types
  .model({
    id: types.optional(types.identifier, guidGenerator),
    pid: types.optional(types.string, guidGenerator),
    type: "pdfrectangleregion",
    object: types.late(() => types.reference(PdfModel)),

    x: types.number,
    y: types.number,
    width: types.number,
    height: types.number,

    rotation: 0,
    rotationAtCreation: 0,

    // PDF-specific: page index (1-based)
    pageIndex: types.optional(types.number, 1),
  })
  .volatile(() => ({
    startX: 0,
    startY: 0,

    scaleX: 1,
    scaleY: 1,

    opacity: 1,

    fill: true,
    fillColor: "#ff8800",
    fillOpacity: 0.2,

    strokeColor: Constants.STROKE_COLOR,
    strokeWidth: Constants.STROKE_WIDTH,

    _supportsTransform: true,
    hideable: true,

    editableFields: [
      { property: "x", label: "X" },
      { property: "y", label: "Y" },
      { property: "width", label: "W" },
      { property: "height", label: "H" },
      { property: "rotation", label: "icon:angle" },
      { property: "pageIndex", label: "Page" },
    ],
  }))
  .volatile(() => {
    return {
      useTransformer: true,
      preferTransformer: true,
      supportsRotate: true,
      supportsScale: true,
    };
  })
  .views((self) => ({
    get store() {
      return getRoot(self);
    },
    get parent() {
      return isAlive(self) ? self.object : null;
    },
    get bboxCoords() {
      const bboxCoords = {
        left: self.x,
        top: self.y,
        right: self.x + self.width,
        bottom: self.y + self.height,
      };

      if (self.rotation === 0 || !self.parent) return bboxCoords;

      return rotateBboxCoords(bboxCoords, self.rotation, { x: self.x, y: self.y }, self.parent.whRatio);
    },
    get canvasX() {
      return isFF(FF_DEV_3793) ? self.parent?.internalToCanvasX(self.x) : self.x;
    },
    get canvasY() {
      return isFF(FF_DEV_3793) ? self.parent?.internalToCanvasY(self.y) : self.y;
    },
    get canvasWidth() {
      return isFF(FF_DEV_3793) ? self.parent?.internalToCanvasX(self.width) : self.width;
    },
    get canvasHeight() {
      return isFF(FF_DEV_3793) ? self.parent?.internalToCanvasY(self.height) : self.height;
    },
  }))
  .actions((self) => ({
    afterCreate() {
      self.startX = self.x;
      self.startY = self.y;
      // Set pageIndex if not already set
      if (!self.pageIndex && self.parent) {
        self.pageIndex = self.parent.currentPage || 1;
      }
    },

    setPageIndex(pageIndex) {
      self.pageIndex = pageIndex;
    },

    beforeSetPosition(x, y, width, height, rotation) {
      // Konva flipping fix (same as RectRegion)
      if (height < 0) {
        let flippedBack;
        const deltaRotation = Math.abs(rotation - self.rotation) % 360;
        if (deltaRotation > 90 && deltaRotation < 270) {
          flippedBack = self.flipBack({ x, y, width, height, rotation }, true);
        } else {
          flippedBack = self.flipBack({ x, y, width, height, rotation });
        }
        [x, y, width, height, rotation] = [
          flippedBack.x,
          flippedBack.y,
          flippedBack.width,
          flippedBack.height,
          flippedBack.rotation,
        ];
      }
      return [x, y, width, height, rotation];
    },

    flipBack(attrs, isHorizontalFlip = false) {
      // Same as RectRegion - handles Konva's negative scale values
      let { x, y, width, height, rotation } = attrs;
      const radiansRotation = (rotation * Math.PI) / 180;
      const transform = new Konva.Transform();
      transform.rotate(radiansRotation);
      let targetCorner;

      if (isHorizontalFlip) {
        targetCorner = { x: width, y: 0 };
        rotation = (rotation + 180) % 360;
      } else {
        targetCorner = { x: 0, y: height };
      }
      const offset = transform.point(targetCorner);

      return {
        x: x + offset.x,
        y: y + offset.y,
        width,
        height: -height,
        rotation,
      };
    },

    /**
     * Set position on canvas - converts canvas coords to normalized (per-page)
     * @param {number} x - canvas x coordinate
     * @param {number} y - canvas y coordinate
     * @param {number} width - canvas width
     * @param {number} height - canvas height
     * @param {number} rotation - rotation in degrees
     */
    setPosition(x, y, width, height, rotation) {
      [x, y, width, height, rotation] = self.beforeSetPosition(x, y, width, height, rotation);
      
      // Convert canvas coords to internal (normalized) coords
      const internalX = self.parent.canvasToInternalX(x);
      const internalY = self.parent.canvasToInternalY(y);
      const internalWidth = self.parent.canvasToInternalX(width);
      const internalHeight = self.parent.canvasToInternalY(height);

      // For PDF, coordinates are normalized per-page (0-100 relative to page dimensions)
      // This is already handled by canvasToInternal which uses stageWidth/stageHeight
      // which are page-specific
      self.setPositionInternal(internalX, internalY, internalWidth, internalHeight, rotation);
    },

    setPositionInternal(x, y, width, height, rotation) {
      self.x = x;
      self.y = y;
      self.width = width;
      self.height = height;
      self.rotation = (rotation + 360) % 360;
    },

    serialize() {
      const pageIndex = self.pageIndex || 1;
      const pageEntity = self.parent?.findPageEntity(pageIndex);

      const value = {
        x: self.x, // Already normalized 0-100
        y: self.y,
        width: self.width,
        height: self.height,
        rotation: self.rotation,
      };

      return self.parent.createSerializedResult(self, value);
    },
  }));

const PdfRectRegionModel = types.compose(
  "PdfRectRegionModel",
  RegionsMixin,
  NormalizationMixin,
  AreaMixin,
  KonvaRegionMixin,
  EditableRegion,
  Model,
);

const HtxPdfRectangleView = ({ item, setShapeRef }) => {
  const { store } = item;

  const { suggestion } = useContext(ImageViewContext) ?? {};
  const regionStyles = useRegionStyles(item, { suggestion });
  const stage = item.parent?.stageRef;

  const eventHandlers = {};

  if (!item.parent) return null;
  // Only show regions for current page
  if (item.pageIndex !== item.parent.currentPage) return null;

  if (!suggestion && !item.isReadOnly()) {
    eventHandlers.onTransformEnd = (e) => {
      const t = e.target;
      item.setPosition(
        t.getAttr("x"),
        t.getAttr("y"),
        t.getAttr("width") * t.getAttr("scaleX"),
        t.getAttr("height") * t.getAttr("scaleY"),
        t.getAttr("rotation"),
      );
      t.setAttr("scaleX", 1);
      t.setAttr("scaleY", 1);
      item.notifyDrawingFinished();
    };

    eventHandlers.onDragStart = (e) => {
      if (item.parent.getSkipInteractions()) {
        e.currentTarget.stopDrag(e.evt);
        return;
      }
      item.annotation.history.freeze(item.id);
    };

    eventHandlers.onDragEnd = (e) => {
      const t = e.target;
      item.setPosition(t.getAttr("x"), t.getAttr("y"), t.getAttr("width"), t.getAttr("height"), t.getAttr("rotation"));
      item.setScale(t.getAttr("scaleX"), t.getAttr("scaleY"));
      item.annotation.history.unfreeze(item.id);
      item.notifyDrawingFinished();
    };

    eventHandlers.dragBoundFunc = createDragBoundFunc(item, {
      x: item.x - item.bboxCoords.left,
      y: item.y - item.bboxCoords.top,
    });
  }

  return (
    <RegionWrapper item={item}>
      <Rect
        x={item.canvasX}
        y={item.canvasY}
        ref={(node) => setShapeRef(node)}
        width={item.canvasWidth}
        height={item.canvasHeight}
        fill={regionStyles.fillColor}
        stroke={regionStyles.strokeColor}
        strokeWidth={regionStyles.strokeWidth}
        strokeScaleEnabled={false}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
        shadowBlur={0}
        dash={suggestion ? [10, 10] : null}
        scaleX={item.scaleX}
        scaleY={item.scaleY}
        opacity={1}
        rotation={item.rotation}
        draggable={!item.isReadOnly()}
        name={`${item.id} _transformable`}
        {...eventHandlers}
        onMouseOver={() => {
          if (store.annotationStore.selected.isLinkingMode) {
            item.setHighlight(true);
          }
          item.updateCursor(true);
        }}
        onMouseOut={() => {
          if (store.annotationStore.selected.isLinkingMode) {
            item.setHighlight(false);
          }
          item.updateCursor();
        }}
        onClick={(e) => {
          if (item.parent.getSkipInteractions()) return;
          if (store.annotationStore.selected.isLinkingMode) {
            stage.container().style.cursor = Constants.DEFAULT_CURSOR;
          }
          item.setHighlight(false);
          item.onClickRegion(e);
        }}
        listening={!suggestion && !item.annotation?.isDrawing}
      />
      <LabelOnRect item={item} color={regionStyles.strokeColor} strokewidth={regionStyles.strokeWidth} />
    </RegionWrapper>
  );
};

const HtxPdfRectangle = AliveRegion(HtxPdfRectangleView);

Registry.addTag("pdfrectangleregion", PdfRectRegionModel, HtxPdfRectangle);
Registry.addRegionType(PdfRectRegionModel, "pdf");

export { PdfRectRegionModel, HtxPdfRectangle };

