# Image Rendering and Annotation Flow - Complete Walkthrough

This document explains the complete flow of how Label Studio renders images and handles annotations, from initial load to saving annotations.

## Table of Contents
1. [Image Loading & Initialization](#1-image-loading--initialization)
2. [Image Rendering](#2-image-rendering)
3. [Canvas Setup (Konva Stage)](#3-canvas-setup-konva-stage)
4. [Event Handling Flow](#4-event-handling-flow)
5. [Drawing Tools & Region Creation](#5-drawing-tools--region-creation)
6. [Region Rendering](#6-region-rendering)
7. [Annotation Serialization](#7-annotation-serialization)
8. [Saving Annotations](#8-saving-annotations)

---

## 1. Image Loading & Initialization

### 1.1 Image Entity Creation
**File:** `web/libs/editor/src/tags/object/Image/ImageEntity.js`

When an image tag is encountered in the labeling config, the system creates `ImageEntity` instances:

```javascript
// ImageEntity stores per-image properties
{
  id: "image#0",
  src: "https://example.com/image.jpg",
  index: 0,
  naturalWidth: 1920,  // Original image dimensions
  naturalHeight: 1080,
  rotation: 0,
  zoomScale: 1,
  brightnessGrade: 100,
  contrastGrade: 100
}
```

### 1.2 Image Preloading
**File:** `web/libs/editor/src/tags/object/Image/ImageEntity.js` (lines 79-121)

The `preload()` action handles image downloading:

1. **Check if already preloaded** - Uses `FileLoader` to cache images
2. **Create Image object** - Creates a browser `Image` object with CORS settings
3. **Download progress** - Tracks download progress (0-1)
4. **Set currentSrc** - Once loaded, sets `currentSrc` (can be blob URL for local files)
5. **Mark as downloaded** - Sets `downloaded: true` and `imageLoaded: true`

```javascript
preload() {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    self.setCurrentSrc(self.src);
    self.setDownloaded(true);
    self.setImageLoaded(true);
  };
  img.src = self.src;
}
```

### 1.3 Image Model Setup
**File:** `web/libs/editor/src/tags/object/Image/Image.js` (lines 601-627)

The `Image` model creates entities and initializes tools:

1. **Parse image value** - Can be single URL or array of URLs (multi-image)
2. **Create ImageEntity instances** - One per image
3. **Set current image** - Defaults to first image (index 0)
4. **Initialize tools** - Adds drawing tools (Rectangle, Polygon, Brush, etc.)

```javascript
createImageEntities() {
  const parsedValue = self.multiImage ? self.parsedValueList : self.parsedValue;
  
  if (Array.isArray(parsedValue)) {
    parsedValue.forEach((src, index) => {
      self.imageEntities.push({
        id: `${self.name}#${index}`,
        src,
        index,
      });
    });
  } else {
    self.imageEntities.push({
      id: `${self.name}#0`,
      src: parsedValue,
      index: 0,
    });
  }
}
```

---

## 2. Image Rendering

### 2.1 Image Component
**File:** `web/libs/editor/src/components/ImageView/Image.jsx`

The `Image` component renders the actual `<img>` tag:

1. **Shows progress** - Displays download progress bar while loading
2. **Handles errors** - Shows error message if download fails
3. **Image renderer** - Renders the image with transform styles (brightness, contrast, rotation)
4. **Hidden visually** - Image is clipped to 1px (for Magic Wand tool access) but visible to canvas

```javascript
<ImageRenderer
  src={imageEntity.currentSrc}
  onLoad={onLoad}
  imageTransform={imageTransform}  // brightness, contrast, rotation
/>
```

### 2.2 Image Transform
**File:** `web/libs/editor/src/tags/object/Image/Image.js`

The image transform includes:
- **Brightness** - `brightnessGrade` (0-200, default 100)
- **Contrast** - `contrastGrade` (0-200, default 100)
- **Rotation** - `rotation` (0, 90, 180, 270 degrees)
- **Zoom** - Applied via Konva Stage scale

---

## 3. Canvas Setup (Konva Stage)

### 3.1 Stage Component
**File:** `web/libs/editor/src/components/ImageView/ImageView.jsx` (lines 1254-1280)

The `EntireStage` component creates a Konva `Stage` (HTML5 Canvas wrapper):

```javascript
<Stage
  ref={item.setStageRef}
  width={size.width}
  height={size.height}
  scaleX={item.zoomScale}
  scaleY={item.zoomScale}
  x={position.x}
  y={position.y}
  rotation={item.rotation}
  onClick={onClick}
  onMouseDown={onMouseDown}
  onMouseMove={onMouseMove}
  onMouseUp={onMouseUp}
  onWheel={onWheel}
>
  <StageContent item={item} />
</Stage>
```

**Key Properties:**
- **width/height** - Canvas dimensions (matches image display size)
- **scaleX/scaleY** - Zoom level (1.0 = 100%, 2.0 = 200%)
- **x/y** - Pan position (for zoomed images)
- **rotation** - Image rotation

### 3.2 Image Layer
**File:** `web/libs/editor/src/components/ImageView/ImageView.jsx` (lines 1284-1331)

The `ImageLayer` component renders the image on the Konva canvas:

1. **Load image** - Creates Image object from `currentSrc`
2. **Apply filters** - Applies brightness and contrast filters via Konva
3. **Render KonvaImage** - Renders image as Konva Image node

```javascript
<Layer imageSmoothingEnabled={item.smoothingEnabled}>
  <KonvaImage 
    image={loadedImage} 
    width={width} 
    height={height} 
    listening={false}  // Image doesn't capture mouse events
  />
</Layer>
```

**Why two images?**
- The hidden `<img>` tag is used by tools like Magic Wand (needs pixel data)
- The Konva Image is what users see and what annotations are drawn on

---

## 4. Event Handling Flow

### 4.1 Event Flow Diagram

```
User Mouse Event
    ↓
Konva Stage (onMouseDown/Move/Up)
    ↓
ImageView.handleMouseDown/Move/Up
    ↓
Image.event(name, ev, screenX, screenY)
    ↓
ToolsManager.event(name, ev, x, y, canvasX, canvasY)
    ↓
SelectedTool.event(name, ev, [x, y, canvasX, canvasY])
    ↓
Tool-specific handler (mousedownEv, mousemoveEv, mouseupEv)
```

### 4.2 Coordinate Transformation

**File:** `web/libs/editor/src/tags/object/Image/Image.js` (lines 1214-1221)

Events go through coordinate transformation:

1. **Screen coordinates** - Raw mouse position from browser event
2. **Canvas coordinates** - Account for zoom/pan/rotation via `fixZoomedCoords()`
3. **Internal coordinates** - Convert to image coordinate system (0-100% or pixels)

```javascript
event(name, ev, screenX, screenY) {
  // Fix coordinates for zoom/pan/rotation
  const [canvasX, canvasY] = self.fixZoomedCoords([screenX, screenY]);
  
  // Convert to internal coordinate system
  const x = self.canvasToInternalX(canvasX);
  const y = self.canvasToInternalY(canvasY);
  
  // Forward to tool manager
  self.getToolsManager().event(name, ev.evt || ev, x, y, canvasX, canvasY);
}
```

### 4.3 Tools Manager Routing
**File:** `web/libs/editor/src/tools/Manager.js` (lines 183-191)

The ToolsManager routes events to the currently selected tool:

```javascript
event(name, ev, ...args) {
  const selectedTool = this.findSelectedTool();
  
  if (selectedTool) {
    selectedTool.event(name, ev, args);
  }
}
```

---

## 5. Drawing Tools & Region Creation

### 5.1 Tool Types
**File:** `web/libs/editor/src/tools/`

Available drawing tools:
- **RectangleTool** - `Rect.js` (2-point drawing)
- **Rectangle3PointTool** - `Rect.js` (3-point drawing)
- **PolygonTool** - `Polygon.js`
- **BrushTool** - `Brush.js`
- **EllipseTool** - `Ellipse.js`
- **KeyPointTool** - `KeyPoint.js`

### 5.2 Drawing Flow (Rectangle Example)

**File:** `web/libs/editor/src/tools/Rect.js` + `web/libs/editor/src/mixins/DrawingTool.js`

#### Step 1: Mouse Down - Start Drawing
```javascript
// Rect.js - mousedownEv handler
mousedownEv(ev, [x, y]) {
  if (!self.canStartDrawing()) return;
  
  startPoint = { x, y };
  modeAfterMouseMove = DRAG_MODE;  // Will start drawing on drag
}
```

#### Step 2: Mouse Move - Update Drawing
```javascript
// DrawingTool.js - updateDraw (throttled to 48ms)
updateDraw(x, y) {
  if (currentMode === DEFAULT_MODE) return;
  self.draw(x, y);  // Update region shape
}

// Rect.js - draw method
draw(x, y) {
  const shape = self.getCurrentArea();  // Get temporary drawing region
  
  // Calculate rectangle bounds from start point to current point
  let { x1, y1, x2, y2 } = Utils.Image.reverseCoordinates(
    { x: shape.startX, y: shape.startY }, 
    { x, y }
  );
  
  // Clamp to canvas bounds
  x1 = Math.max(0, x1);
  y1 = Math.max(0, y1);
  x2 = Math.min(maxStageWidth, x2);
  y2 = Math.min(maxStageHeight, y2);
  
  // Update region position
  shape.setPositionInternal(x1, y1, x2-x1, y2-y1, shape.rotation);
}
```

#### Step 3: Create Drawing Region
**File:** `web/libs/editor/src/mixins/DrawingTool.js` (lines 220-224)

When drawing starts, a temporary "drawing region" is created:

```javascript
startDrawing(x, y) {
  self.annotation.history.freeze();  // Don't track intermediate states
  self.mode = "drawing";
  
  // Create temporary region
  self.currentArea = self.createDrawingRegion(
    self.createRegionOptions({ x, y })
  );
}
```

**File:** `web/libs/editor/src/tags/object/Image/Image.js` (lines 727-748)

```javascript
createDrawingRegion(areaValue, resultValue, control, dynamic) {
  const result = {
    from_name: controlTag,
    to_name: self,
    type: control.resultType,  // e.g., "rectanglelabels"
    value: resultValue,
  };
  
  const areaRaw = {
    id: guidGenerator(),
    object: self,
    ...areaValue,  // x, y, width, height
    results: [result],
    dynamic,
    item_index: self.currentImage,
  };
  
  self.drawingRegion = areaRaw;  // Temporary region
  return self.drawingRegion;
}
```

#### Step 4: Mouse Up - Commit Drawing
**File:** `web/libs/editor/src/mixins/DrawingTool.js` (lines 225-243)

```javascript
finishDrawing() {
  if (!self.beforeCommitDrawing()) {
    // Region too small, delete it
    self.deleteRegion();
    self._resetState();
  } else {
    // Commit the region
    self._finishDrawing();
  }
}

_finishDrawing() {
  self.commitDrawingRegion();  // Convert to permanent region
  self._resetState();
}
```

#### Step 5: Commit Drawing Region
**File:** `web/libs/editor/src/mixins/DrawingTool.js` (lines 150-200)

```javascript
commitDrawingRegion() {
  const { currentArea, control, obj } = self;
  
  if (!currentArea) return;
  
  // Serialize the region value
  const source = currentArea.toJSON();
  const value = {
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    rotation: source.rotation,
    coordstype: "px",  // or "perc"
    dynamic: self.dynamic,
    converted: true,
  };
  
  // Create permanent annotation result
  const [main, ...rest] = currentArea.results;
  const newArea = self.annotation.createResult(
    value, 
    main.value.toJSON(), 
    control, 
    obj
  );
  
  // Add additional labels if multiple labels selected
  rest.forEach((r) => newArea.addResult(r.toJSON()));
  
  // Clean up temporary region
  currentArea.setDrawing(false);
  self.deleteRegion();
  
  return newArea;
}
```

---

## 6. Region Rendering

### 6.1 Region Types
**File:** `web/libs/editor/src/components/ImageView/ImageView.jsx` (lines 40-66)

Regions are split into categories for rendering:

```javascript
const splitRegions = (regions) => {
  const brushRegions = [];      // Brush/bitmask regions
  const shapeRegions = [];      // Rectangle, polygon, ellipse, etc.
  const bitmaskRegions = [];    // Bitmask regions
  const vectorRegions = [];     // Vector regions
  
  // Categorize each region
  for (const region of regions) {
    switch (region.type) {
      case "brushregion":
        brushRegions.push(region);
        break;
      case "bitmaskregion":
        bitmaskRegions.push(region);
        break;
      default:
        shapeRegions.push(region);
        break;
    }
  }
  
  return { brushRegions, bitmaskRegions, vectorRegions, shapeRegions };
};
```

### 6.2 Region Component
**File:** `web/libs/editor/src/components/ImageView/ImageView.jsx` (lines 68-84)

Each region is rendered using the Tree system:

```javascript
const Region = memo(({ region, showSelected = false }) => {
  return useObserver(() => Tree.renderItem(region, region.annotation, true));
});
```

**File:** `web/libs/editor/src/regions/RectRegion.jsx`

The `RectRegion` component renders a Konva `Rect`:

```javascript
// RectRegion.jsx - render method
<Rect
  x={self.x}
  y={self.y}
  width={self.width}
  height={self.height}
  rotation={self.rotation}
  stroke={strokeColor}
  fill={fillColor}
  opacity={self.opacity}
  draggable={!self.isReadOnly()}
  onDragEnd={self.onDragEnd}
  // ... more props
/>
```

### 6.3 Drawing Region (Temporary)
**File:** `web/libs/editor/src/components/ImageView/ImageView.jsx` (lines 105-119)

While drawing, a temporary region is shown:

```javascript
const DrawingRegion = observer(({ item }) => {
  const { drawingRegion } = item;
  
  if (!drawingRegion) return null;
  
  // Render the temporary region
  return (
    <Wrapper imageSmoothingEnabled={item.smoothingEnabled}>
      <Region key="drawing" region={drawingRegion} />
    </Wrapper>
  );
});
```

### 6.4 Region Layers
**File:** `web/libs/editor/src/components/ImageView/ImageView.jsx` (lines 1430-1453)

Regions are rendered in layers for performance:

```javascript
{renderableRegions.map(([groupName, list]) => {
  const useLayers = groupName.match(/brush/i) === null;
  
  return list.length > 0 ? (
    <Regions
      key={groupName}
      regions={list}
      useLayers={useLayers}  // Brush regions don't use layers
      suggestion={isSuggestion}
      smoothing={item.smoothingEnabled}
    />
  ) : null;
})}
```

**Why chunking?** Regions are split into chunks of 15 for performance (rendering many regions can be slow).

---

## 7. Annotation Serialization

### 7.1 Region Serialization
**File:** `web/libs/editor/src/regions/RectRegion.jsx` (lines 200-250)

When a region is serialized, coordinates are converted:

```javascript
serialize() {
  const value = {
    // Convert to percentages if stageWidth > 1
    x: self.parent.stageWidth > 1 
      ? self.convertXToPerc(self.x) 
      : self.x,
    y: self.parent.stageHeight > 1 
      ? self.convertYToPerc(self.y) 
      : self.y,
    width: self.parent.stageWidth > 1 
      ? self.convertHDimensionToPerc(self.width) 
      : self.width,
    height: self.parent.stageHeight > 1 
      ? self.convertVDimensionToPerc(self.height) 
      : self.height,
    rotation: self.rotation,
  };
  
  return self.parent.createSerializedResult(self, value);
}
```

### 7.2 Annotation Result Structure
**File:** `web/libs/editor/src/core/Annotation.js`

An annotation result has this structure:

```javascript
{
  id: "result-123",
  from_name: "label",        // Control tag name
  to_name: "image",           // Object tag name
  type: "rectanglelabels",   // Result type
  value: {
    x: 10.5,                 // Percentage (0-100)
    y: 20.3,
    width: 30.2,
    height: 25.1,
    rotation: 0,
    rectanglelabels: ["car", "vehicle"]  // Selected labels
  },
  original_width: 1920,      // Image dimensions
  original_height: 1080,
  image_rotation: 0
}
```

### 7.3 Coordinate Systems

Label Studio uses two coordinate systems:

1. **Percentage (perc)** - Default, 0-100% of image dimensions
   - Works regardless of image size
   - Example: `{x: 25, y: 30, width: 50, height: 40}` = 25% from left, 30% from top, 50% wide, 40% tall

2. **Pixels (px)** - Absolute pixel coordinates
   - Fixed to specific image dimensions
   - Example: `{x: 480, y: 324, width: 960, height: 432}` for 1920x1080 image

**Conversion:**
```javascript
// Percentage to pixels
pixelX = (percentageX / 100) * imageWidth
pixelY = (percentageY / 100) * imageHeight

// Pixels to percentage
percentageX = (pixelX / imageWidth) * 100
percentageY = (pixelY / imageHeight) * 100
```

---

## 8. Saving Annotations

### 8.1 Frontend to Backend
**File:** `web/libs/editor/src/core/Annotation.js`

When user saves (or auto-saves), the annotation is serialized:

```javascript
// Get all results from all regions
const results = self.regions.map(region => region.serialize());

// Create annotation payload
const payload = {
  result: results,  // Array of result objects
  was_cancelled: false,
  ground_truth: false,
  // ... other metadata
};
```

### 8.2 API Request
**File:** `web/libs/editor/src/core/Annotation.js`

The annotation is sent to the backend:

```javascript
// POST /api/tasks/{task_id}/annotations/
fetch(`/api/tasks/${taskId}/annotations/`, {
  method: 'POST',
  body: JSON.stringify(payload),
  headers: { 'Content-Type': 'application/json' }
});
```

### 8.3 Backend Storage
**File:** `label_studio/tasks/api.py`

The backend receives and stores the annotation:

```python
class AnnotationsListAPI(generics.ListCreateAPIView):
    def perform_create(self, serializer):
        result = serializer.validated_data.get('result')
        task = self.get_object()
        
        # Create annotation
        annotation = serializer.save(
            task_id=task.id,
            project_id=task.project_id
        )
        
        # Result is stored as JSON in the database
        # annotation.result = [
        #   {
        #     "from_name": "label",
        #     "to_name": "image",
        #     "type": "rectanglelabels",
        #     "value": {
        #       "x": 10.5,
        #       "y": 20.3,
        #       "width": 30.2,
        #       "height": 25.1,
        #       "rectanglelabels": ["car"]
        #     },
        #     "original_width": 1920,
        #     "original_height": 1080
        #   }
        # ]
```

### 8.4 Database Model
**File:** `label_studio/tasks/models.py`

The `Annotation` model stores:

```python
class Annotation(models.Model):
    task = models.ForeignKey(Task, on_delete=models.CASCADE)
    result = models.JSONField()  # Array of result objects
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # ... other fields
```

---

## Summary: Complete Flow

1. **Image Loads**
   - `ImageEntity.preload()` downloads image
   - `Image.createImageEntities()` creates entity instances
   - Image is cached via `FileLoader`

2. **Image Renders**
   - `<img>` tag loads (hidden, for tool access)
   - Konva `ImageLayer` renders image on canvas
   - Brightness/contrast filters applied

3. **User Clicks Tool**
   - Tool selected in `ToolsManager`
   - Tool becomes active

4. **User Draws Region**
   - Mouse down: `startDrawing()` creates temporary region
   - Mouse move: `updateDraw()` updates region shape
   - Mouse up: `commitDrawingRegion()` converts to permanent region

5. **Region Renders**
   - Temporary region shown while drawing
   - Permanent regions rendered in layers
   - Regions are interactive (draggable, resizable)

6. **User Saves**
   - Regions serialized to annotation format
   - Coordinates converted to percentages
   - POST request to `/api/tasks/{id}/annotations/`
   - Backend stores in database as JSON

---

## Key Files Reference

- **Image Model:** `web/libs/editor/src/tags/object/Image/Image.js`
- **Image Entity:** `web/libs/editor/src/tags/object/Image/ImageEntity.js`
- **Image View:** `web/libs/editor/src/components/ImageView/ImageView.jsx`
- **Image Component:** `web/libs/editor/src/components/ImageView/Image.jsx`
- **Drawing Tools:** `web/libs/editor/src/mixins/DrawingTool.js`
- **Rectangle Tool:** `web/libs/editor/src/tools/Rect.js`
- **Rectangle Region:** `web/libs/editor/src/regions/RectRegion.jsx`
- **Tools Manager:** `web/libs/editor/src/tools/Manager.js`
- **Backend API:** `label_studio/tasks/api.py`

