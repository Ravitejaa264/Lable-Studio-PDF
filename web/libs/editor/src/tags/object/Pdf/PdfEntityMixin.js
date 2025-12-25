import { isAlive, types } from "mobx-state-tree";
import { PdfPageEntity } from "./PdfPageEntity";

export const PdfEntityMixin = types
  .model({
    currentPageEntity: types.maybeNull(types.reference(PdfPageEntity)),

    pageEntities: types.optional(types.array(PdfPageEntity), []),
  })
  .actions((self) => {
    return {
      beforeDestroy() {
        self.currentPageEntity = null;
      },
    };
  })
  .views((self) => ({
    get maxPageIndex() {
      return self.pageEntities.length - 1;
    },

    get pdfIsLoaded() {
      const pageEntity = self.currentPageEntity;
      return pageEntity && !pageEntity.loading && !pageEntity.error && pageEntity.pageLoaded;
    },

    get currentPage() {
      return self.currentPageEntity?.pageIndex ?? 1;
    },

    get totalPages() {
      return self.pageEntities.length;
    },

    get rotation() {
      if (!isAlive(self)) {
        return void 0;
      }
      return self.currentPageEntity?.rotation;
    },
    set rotation(value) {
      self.currentPageEntity?.setRotation(value);
    },

    get naturalWidth() {
      return self.currentPageEntity?.naturalWidth;
    },
    set naturalWidth(value) {
      self.currentPageEntity?.setNaturalWidth(value);
    },

    get naturalHeight() {
      return self.currentPageEntity?.naturalHeight;
    },
    set naturalHeight(value) {
      self.currentPageEntity?.setNaturalHeight(value);
    },

    get stageWidth() {
      return self.currentPageEntity?.stageWidth;
    },
    set stageWidth(value) {
      self.currentPageEntity?.setStageWidth(value);
    },

    get stageHeight() {
      return self.currentPageEntity?.stageHeight;
    },
    set stageHeight(value) {
      self.currentPageEntity?.setStageHeight(value);
    },

    get stageRatio() {
      return self.currentPageEntity?.stageRatio;
    },
    set stageRatio(value) {
      self.currentPageEntity?.setStageRatio(value);
    },

    get containerWidth() {
      return self.currentPageEntity?.containerWidth;
    },
    set containerWidth(value) {
      self.currentPageEntity?.setContainerWidth(value);
    },

    get containerHeight() {
      return self.currentPageEntity?.containerHeight;
    },
    set containerHeight(value) {
      self.currentPageEntity?.setContainerHeight(value);
    },

    get stageZoom() {
      return self.currentPageEntity?.stageZoom;
    },
    set stageZoom(value) {
      self.currentPageEntity?.setStageZoom(value);
    },

    get stageZoomX() {
      return self.currentPageEntity?.stageZoomX;
    },
    set stageZoomX(value) {
      self.currentPageEntity?.setStageZoomX(value);
    },

    get stageZoomY() {
      return self.currentPageEntity?.stageZoomY;
    },
    set stageZoomY(value) {
      self.currentPageEntity?.setStageZoomY(value);
    },

    get currentZoom() {
      return self.currentPageEntity?.currentZoom;
    },
    set currentZoom(value) {
      self.currentPageEntity?.setCurrentZoom(value);
    },

    get zoomScale() {
      if (!isAlive(self)) {
        return void 0;
      }
      return self.currentPageEntity?.zoomScale;
    },
    set zoomScale(value) {
      self.currentPageEntity?.setZoomScale(value);
    },

    get zoomingPositionX() {
      if (!isAlive(self)) {
        return void 0;
      }
      return self.currentPageEntity?.zoomingPositionX;
    },
    set zoomingPositionX(value) {
      self.currentPageEntity?.setZoomingPositionX(value);
    },

    get zoomingPositionY() {
      if (!isAlive(self)) {
        return null;
      }
      return self.currentPageEntity?.zoomingPositionY;
    },
    set zoomingPositionY(value) {
      self.currentPageEntity?.setZoomingPositionY(value);
    },

    findPageEntity(pageIndex) {
      // pageIndex is 1-based
      return self.pageEntities.find((entity) => entity.pageIndex === pageIndex);
    },

    findPageEntityByIndex(index) {
      // index is 0-based array index
      return self.pageEntities[index];
    },
  }));

