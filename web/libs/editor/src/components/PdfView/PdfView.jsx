import { Component, createRef, Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer, Rect, Stage, Image as KonvaImage } from "react-konva";
import { observer } from "mobx-react";
import { getEnv, getRoot, isAlive } from "mobx-state-tree";
import * as pdfjsLib from "pdfjs-dist";

import ImageTransformer from "../ImageTransformer/ImageTransformer";
import ObjectTag from "../../components/Tags/Object";
import Tree from "../../core/Tree";
import styles from "../ImageView/ImageView.module.scss";
import { errorBuilder } from "../../core/DataValidator/ConfigValidator";
import Konva from "konva";
import { LoadingOutlined } from "@ant-design/icons";
import { Toolbar } from "../Toolbar/Toolbar";
import { Hotkey } from "../../core/Hotkey";
import { Pagination } from "../../common/Pagination/Pagination";
import Constants from "../../core/Constants";
import {
  FF_DEV_1442,
  FF_DEV_3793,
  FF_LSDV_4930,
  FF_ZOOM_OPTIM,
  isFF,
} from "../../utils/feature-flags";
import { debounce } from "../../utils/debounce";
import ResizeObserver from "../../utils/resize-observer";
import { chunks, findClosestParent } from "../../utils/utilities";
import { ImageViewContext } from "../ImageView/ImageViewContext";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const hotkeys = Hotkey("Pdf");

const Region = memo(({ region, showSelected = false }) => {
  return Tree.renderItem(region, region.annotation, true);
});

const RegionsLayer = memo(({ regions, name, useLayers, showSelected = false }) => {
  const content = regions.map((el) => {
    return <Region key={`region-${el.id}`} region={el} showSelected={showSelected} />;
  });

  return useLayers === false ? (
    content
  ) : (
    <Layer name={name}>
      {content}
    </Layer>
  );
});

const Regions = memo(({ regions, useLayers = true, chunkSize = 15, suggestion = false, showSelected = false }) => {
  return (
    <ImageViewContext.Provider value={{ suggestion }}>
      {(chunkSize ? chunks(regions, chunkSize) : regions).map((chunk, i) => (
        <RegionsLayer
          key={`chunk-${i}`}
          name={`chunk-${i}`}
          regions={chunk}
          useLayers={useLayers}
          showSelected={showSelected}
        />
      ))}
    </ImageViewContext.Provider>
  );
});

const SELECTION_COLOR = "#40A9FF";
const SELECTION_SECOND_COLOR = "white";
const SELECTION_DASH = [3, 3];

/**
 * PDF Page Layer - renders a single PDF page using PDF.js
 */
const PdfPageLayer = observer(({ item, pageIndex }) => {
  const konvaImageRef = useRef();
  const [renderedCanvas, setRenderedCanvas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const pageEntity = item.findPageEntity(pageIndex);

  useEffect(() => {
    if (!item.parsedValue || !pageEntity) return;

    let cancelled = false;

    async function loadAndRenderPage() {
      try {
        setLoading(true);
        setError(false);

        // Load PDF document if not already loaded (reuse from first page or parent)
        let pdf = pageEntity.pdfDocument;
        if (!pdf && item.pageEntities.length > 0) {
          // Try to get PDF document from first page entity
          const firstPage = item.findPageEntity(1);
          pdf = firstPage?.pdfDocument;
        }
        
        if (!pdf) {
          const loadingTask = pdfjsLib.getDocument({
            url: item.parsedValue,
            cMapUrl: `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/cmaps/`,
            cMapPacked: true,
          });
          pdf = await loadingTask.promise;
        }

        // Share PDF document with all page entities
        if (!pageEntity.pdfDocument) {
          pageEntity.setPdfDocument(pdf);
          // Share with other page entities
          item.pageEntities.forEach((pe) => {
            if (!pe.pdfDocument) {
              pe.setPdfDocument(pdf);
            }
          });
        }

        // Load page if not already loaded
        let page = pageEntity.pdfPage;
        if (!page) {
          page = await pdf.getPage(pageIndex); // pageIndex is 1-based
          pageEntity.setPdfPage(page);
        }

        if (cancelled) return;

        // Get viewport (scale for rendering)
        const viewport = page.getViewport({ scale: pageEntity.renderScale || 2.0 });
        const { width, height } = viewport;

        // Update natural dimensions
        pageEntity.setNaturalWidth(width);
        pageEntity.setNaturalHeight(height);

        // Create canvas for rendering
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        canvas.width = width;
        canvas.height = height;

        // Render PDF page to canvas
        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        await page.render(renderContext).promise;

        if (cancelled) return;

        // Convert canvas to image
        const image = new Image();
        image.src = canvas.toDataURL();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
        });

        if (cancelled) return;

        pageEntity.setRenderedCanvas(canvas);
        setRenderedCanvas(image);
        pageEntity.setPageLoaded(true);
        setLoading(false);

        // Update container size if needed
        if (item.containerRef && item.currentPage === pageIndex) {
          const { offsetWidth, offsetHeight } = item.containerRef;
          if (offsetWidth > 1 && offsetHeight > 1) {
            item.onResize(offsetWidth, offsetHeight);
          }
        }
      } catch (err) {
        console.error("Error loading PDF page:", err);
        if (!cancelled) {
          setError(true);
          setLoading(false);
          pageEntity.setError(true);
        }
      }
    }

    // Only load if this is the current page or page entity doesn't have a rendered canvas
    if (item.currentPage === pageIndex || !pageEntity.renderedCanvas) {
      loadAndRenderPage();
    } else {
      // Reuse existing rendered canvas
      if (pageEntity.renderedCanvas) {
        const image = new Image();
        image.src = pageEntity.renderedCanvas.toDataURL();
        image.onload = () => setRenderedCanvas(image);
        setLoading(false);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [item.parsedValue, pageIndex, pageEntity, item.currentPage]);

  const { width, height } = useMemo(() => {
    if (!pageEntity) return { width: 1, height: 1 };
    return {
      width: pageEntity.naturalWidth,
      height: pageEntity.naturalHeight,
    };
  }, [pageEntity?.naturalWidth, pageEntity?.naturalHeight]);

  if (loading) {
    return (
      <Layer>
        <Rect x={0} y={0} width={width} height={height} fill="#f0f0f0" listening={false} />
      </Layer>
    );
  }

  if (error || !renderedCanvas) {
    return (
      <Layer>
        <Rect x={0} y={0} width={width} height={height} fill="#ffcccc" listening={false} />
      </Layer>
    );
  }

  const scale = item.stageZoom || 1;

  return (
    <Layer scaleX={scale} scaleY={scale}>
      <KonvaImage ref={konvaImageRef} image={renderedCanvas} width={width} height={height} listening={false} />
    </Layer>
  );
});

/**
 * Selection layer for PDF regions
 */
const SelectionLayer = observer(({ item }) => {
  const scale = isFF(FF_DEV_3793) ? 1 : 1 / (item.zoomScale || 1);

  let supportsTransform = true;
  let supportsRotate = true;
  let supportsScale = true;

  item.selectedRegions?.forEach((shape) => {
    supportsTransform = supportsTransform && shape.supportsTransform === true;
    supportsRotate = supportsRotate && shape.canRotate === true;
    supportsScale = supportsScale && true;
  });

  supportsTransform =
    supportsTransform &&
    (item.selectedRegions.length > 1 ||
      ((item.useTransformer || item.selectedShape?.preferTransformer) && item.selectedShape?.useTransformer));

  return (
    <Layer scaleX={scale} scaleY={scale}>
      <ImageTransformer
        item={item}
        rotateEnabled={supportsRotate}
        supportsTransform={supportsTransform}
        supportsScale={supportsScale}
        selectedShapes={item.selectedRegions}
        singleNodeMode={item.selectedRegions.length === 1}
        useSingleNodeRotation={item.selectedRegions.length === 1 && supportsRotate}
      />
    </Layer>
  );
});

const Selection = observer(({ item }) => {
  return <SelectionLayer item={item} />;
});

/**
 * Main PDF View Component
 */
export default observer(
  class PdfView extends Component {
    canvasX;
    canvasY;
    lastOffsetWidth = -1;
    lastOffsetHeight = -1;
    state = {
      pointer: [0, 0],
    };

    pdfRef = createRef();
    crosshairRef = createRef();
    handleDeferredMouseDown = null;
    deferredClickTimeout = [];
    skipNextMouseDown = false;
    skipNextClick = false;
    skipNextMouseUp = false;
    mouseDownPoint = null;
    mouseDown = false;

    handleOnClick = (e) => {
      const { item } = this.props;

      if (isFF(FF_DEV_1442)) {
        this.handleDeferredMouseDown?.(true);
      }
      if (this.skipNextClick) {
        this.skipNextClick = false;
        return;
      }

      const evt = e.evt || e;
      const { offsetX: x, offsetY: y } = evt;

      if (isFF(FF_LSDV_4930)) {
        if (
          !this.mouseDownPoint ||
          Math.abs(this.mouseDownPoint.x - x) > 0.01 ||
          Math.abs(this.mouseDownPoint.y - y) > 0.01
        ) {
          this.mouseDownPoint = null;
          return;
        }
      }

      const hoveredRegion = item.regs.find((reg) => {
        if (reg.selected) return false;
        return reg.isHovered?.() ?? false;
      });

      if (hoveredRegion && !evt.defaultPrevented) {
        hoveredRegion.onClickRegion(e);
        return;
      }
      return item.event("click", evt, x, y);
    };

    handleMouseDown = (e) => {
      this.mouseDown = true;
      const { item } = this.props;

      this.skipNextMouseDown = this.skipNextMouseUp = this.skipNextClick = false;
      if (isFF(FF_LSDV_4930)) {
        this.mouseDownPoint = { x: e.evt.offsetX, y: e.evt.offsetY };
      }

      item.updateSkipInteractions(e);

      const p = e.target.getParent();
      if (item.annotation.isReadOnly()) return;
      if (p && p.className === "Transformer") return;

      const handleMouseDown = () => {
        if (e.evt.button === 1) {
          e.evt.preventDefault();
        }

        if (
          item.getSkipInteractions() ||
          e.target === item.stageRef ||
          findClosestParent(e.target, (el) => el.nodeType === "Layer")
        ) {
          window.addEventListener("mousemove", this.handleGlobalMouseMove);
          window.addEventListener("mouseup", this.handleGlobalMouseUp);
          const { offsetX: x, offsetY: y } = e.evt;
          const { left, top } = item.containerRef.getBoundingClientRect();

          this.canvasX = left;
          this.canvasY = top;

          if (this.skipNextMouseDown) {
            this.skipNextMouseDown = false;
            return true;
          }
          item.event("mousedown", e, x, y);
          return true;
        }
      };

      const result = handleMouseDown();
      if (result) return result;
      return true;
    };

    handleGlobalMouseUp = (e) => {
      window.removeEventListener("mousemove", this.handleGlobalMouseMove);
      window.removeEventListener("mouseup", this.handleGlobalMouseUp);

      if (e.target && e.target.tagName === "CANVAS") return;

      const { item } = this.props;
      const { clientX: x, clientY: y } = e;

      return this.triggerMouseUp(e, x - this.canvasX, y - this.canvasY);
    };

    handleGlobalMouseMove = (e) => {
      if (e.target && e.target.tagName === "CANVAS") return;

      const { item } = this.props;
      const { clientX: x, clientY: y } = e;

      return item.event("mousemove", e, x - this.canvasX, y - this.canvasY);
    };

    handleMouseUp = (e) => {
      this.mouseDown = false;
      const { item } = this.props;
      return this.triggerMouseUp(e, e.evt.offsetX, e.evt.offsetY);
    };

    triggerMouseUp = (e, x, y) => {
      if (this.skipNextMouseUp) {
        this.skipNextMouseUp = false;
        return;
      }
      const { item } = this.props;
      return item.event("mouseup", e, x, y);
    };

    handleMouseMove = (e) => {
      const { item } = this.props;
      this.updateCrosshair(e);

      const isMouseWheelClick = e.evt && e.evt.buttons === 4;
      const isDragging = e.evt && e.evt.buttons === 1;
      const isShiftDrag = isDragging && e.evt.shiftKey;

      if ((isMouseWheelClick || isShiftDrag) && item.zoomScale > 1) {
        item.setSkipInteractions(true);
        e.evt.preventDefault();

        const newPos = {
          x: item.zoomingPositionX + e.evt.movementX,
          y: item.zoomingPositionY + e.evt.movementY,
        };

        item.setZoomPosition(newPos.x, newPos.y);
      } else {
        item.event("mousemove", e, e.evt.offsetX, e.evt.offsetY);
      }
    };

    updateCrosshair = (e) => {
      const { item } = this.props;
      if (this.crosshairRef.current) {
        const { x, y } = e.currentTarget.getPointerPosition();
        this.crosshairRef.current.updatePointer(...item.fixZoomedCoords([x, y]));
      }
    };

    handleZoom = (e) => {
      if (e.evt?.ctrlKey || e.evt?.metaKey) {
        e.evt.preventDefault();
        const { item } = this.props;
        const stage = item.stageRef;
        item.handleZoom(e.evt.deltaY, stage.getPointerPosition(), e.evt.ctrlKey);
      }
    };

    handleError = () => {
      const { item, store } = this.props;
      const cs = store.annotationStore;
      const message = getEnv(store).messages.ERR_LOADING_HTTP({
        attr: item.value,
        error: "",
        url: item.currentSrc,
      });
      cs.addErrors([errorBuilder.generalError(message)]);
    };

    onResize = debounce(() => {
      requestAnimationFrame(() => {
        if (!this?.props?.item?.containerRef) return;
        const { offsetWidth, offsetHeight } = this.props.item.containerRef;

        if (this.props.item.naturalWidth <= 1) return;
        if (this.lastOffsetWidth === offsetWidth && this.lastOffsetHeight === offsetHeight) return;

        this.props.item.onResize(offsetWidth, offsetHeight);
        this.lastOffsetWidth = offsetWidth;
        this.lastOffsetHeight = offsetHeight;
      });
    }, 16);

    componentDidMount() {
      const { item } = this.props;
      window.addEventListener("resize", this.onResize);
      this.attachObserver(item.containerRef);
      this.loadPdfDocument();
    }

    attachObserver = (node) => {
      if (this.resizeObserver) this.detachObserver();
      if (node) {
        this.resizeObserver = new ResizeObserver(this.onResize);
        this.resizeObserver.observe(node);
      }
    };

    detachObserver = () => {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
    };

    componentWillUnmount() {
      this.detachObserver();
      window.removeEventListener("resize", this.onResize);
    }

    componentDidUpdate() {
      this.onResize();
    }

    loadPdfDocument = async () => {
      const { item } = this.props;
      if (!item.parsedValue) return;

      try {
        const loadingTask = pdfjsLib.getDocument({
          url: item.parsedValue,
          cMapUrl: `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/cmaps/`,
          cMapPacked: true,
        });

        const pdf = await loadingTask.promise;
        const numPages = pdf.numPages;

        // Create page entities using MST action (MobX-safe)
        item.createPdfPageEntities(numPages, pdf);
      } catch (err) {
        console.error("Error loading PDF:", err);
        this.handleError();
      }
    };

    renderTools() {
      const { item, store } = this.props;
      if (store.annotationStore.viewingAll) return null;
      const tools = item.getToolsManager().allTools();
      return <Toolbar tools={tools} />;
    }

    render() {
      const { item, store } = this.props;

      if (!isAlive(item)) return null;
      if (!store.task || !item.currentSrc) return null;

      const containerStyle = {};
      const containerClassName = styles.container;

      if (getRoot(item).settings.fullscreen === false) {
        containerStyle.maxWidth = item.maxwidth;
        containerStyle.maxHeight = item.maxheight;
        containerStyle.width = item.width;
        containerStyle.height = item.height;
      }

      const pdfPositionClassnames = [
        styles.image_position,
        styles[`image_position__${item.verticalalignment === "center" ? "middle" : item.verticalalignment}`],
        styles[`image_position__${item.horizontalalignment}`],
      ];

      const totalPages = item.totalPages || 1;
      const currentPage = item.currentPage || 1;
      const isViewingAll = store.annotationStore.viewingAll;
      const pdfIsLoaded = item.pdfIsLoaded;
      const toolsReady = item.hasTools;

      return (
        <ObjectTag item={item} className={styles.wrapperComponent}>
          {totalPages > 1 && (
            <div
              className={styles.pagination}
              title={isViewingAll ? "Pagination is not supported in View All Annotations" : undefined}
            >
              <Pagination
                size="small"
                outline={false}
                align="left"
                noPadding
                hotkey={{
                  prev: "pdf:prev",
                  next: "pdf:next",
                }}
                currentPage={currentPage}
                totalPages={totalPages}
                onChange={(n) => item.setCurrentPage(n)}
                pageSizeSelectable={false}
                disabled={isViewingAll}
              />
            </div>
          )}

          <div
            ref={(node) => {
              item.setContainerRef(node);
              this.attachObserver(node);
            }}
            className={containerClassName}
            style={containerStyle}
          >
            {toolsReady && pdfIsLoaded ? (
              <EntireStage
                item={item}
                onClick={this.handleOnClick}
                pdfPositionClassnames={pdfPositionClassnames}
                state={this.state}
                onMouseDown={this.handleMouseDown}
                onMouseMove={this.handleMouseMove}
                onMouseUp={this.handleMouseUp}
                onWheel={item.zoom ? this.handleZoom : () => {}}
              />
            ) : (
              <div className={styles.loading}>
                <LoadingOutlined />
              </div>
            )}
          </div>

          {toolsReady && pdfIsLoaded && this.renderTools()}
        </ObjectTag>
      );
    }
  },
);

const EntireStage = observer(
  ({ item, pdfPositionClassnames, state, onClick, onMouseDown, onMouseMove, onMouseUp, onWheel }) => {
    let size;
    let position;

    if (isFF(FF_ZOOM_OPTIM)) {
      size = {
        width: item.containerWidth,
        height: item.containerHeight,
      };
      position = {
        x: item.zoomingPositionX + item.alignmentOffset.x,
        y: item.zoomingPositionY + item.alignmentOffset.y,
      };
    } else {
      size = { ...item.canvasSize };
      position = {
        x: item.zoomingPositionX,
        y: item.zoomingPositionY,
      };
    }

    // Get regions for current page
    const currentPageRegions = item.regs || [];
    const suggestedRegions = item.suggestions || [];

    return (
      <Stage
        ref={(ref) => {
          item.setStageRef(ref);
        }}
        className={[styles["image-element"], ...pdfPositionClassnames].join(" ")}
        width={size.width}
        height={size.height}
        scaleX={item.zoomScale}
        scaleY={item.zoomScale}
        x={position.x}
        y={position.y}
        offsetX={item.stageTranslate?.x || 0}
        offsetY={item.stageTranslate?.y || 0}
        rotation={item.rotation || 0}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
      >
        <PdfPageLayer item={item} pageIndex={item.currentPage} />
        {currentPageRegions.length > 0 && (
          <Regions
            key="regions"
            name="regions"
            regions={currentPageRegions}
            useLayers={true}
            suggestion={false}
          />
        )}
        {suggestedRegions.length > 0 && (
          <Regions
            key="suggestions"
            name="suggestions"
            regions={suggestedRegions}
            useLayers={true}
            suggestion={true}
          />
        )}
        <Selection item={item} />
      </Stage>
    );
  },
);

