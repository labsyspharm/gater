/**
 * viewer.js.
 * @class ImageViewer to render multiplexed imaging data (based on OpenSeadragon)
 *
 */

/* todo
 1. major - the viewer managers should not be looking up the same renderTF
 */

class ImageViewer {
    // Vars
    viewerManagers = [];

    /**
     * @constructor
     * @param config the cinfiguration file (json)
     * @param dataLayer - the data layer (stub) that executes server requests and holds client side data
     * @param eventHandler - the event handler for distributing interface and data updates
     * @param colorScheme - the color scheme to use or selections etc.
     */
    constructor(config, dataLayer, eventHandler, colorScheme) {
        this.config = config;
        this.eventHandler = eventHandler;
        this.dataLayer = dataLayer;
        this.colorScheme = colorScheme;
        this.channelList = channelList;
        this.clearCache();
        const clearFullCache = () => (this.fullCacheKey = null);
        this.eventHandler.bind(CSVGatingList.events.GATING_BRUSH_END, clearFullCache);

        // Viewer
        this.viewer = {};

        // OSD plugins

        // Stores the ordered contents of the tile cache, so that once we hit max size we remove oldest elements
        this.pendingTiles = new Map();

        // Map of selected ids, key is id
        this.selection = new Map();
        this.data = new Map();

        // Currently loaded label channels
        this.labelChannel = {};
        this.noLabel = false;
        this.sel_outlines = true;
        this.show_scalebar = true;

        // Selection polygon (array of xy positions)
        this.selectionPolygonToDraw = [];

        // Transfer function constant
        this.numTFBins = 1024;

        // Transfer function per channel (min,max, start color, end color)
        this.channelTF = [];
        for (let i = 0; i < this.config["imageData"].length; i = i + 1) {
            const start_color = d3.rgb(0, 0, 0);
            const end_color = d3.rgb(255, 255, 255);

            const tf_def = this.createTFArray(0, 65535, start_color, end_color, this.numTFBins);
            tf_def.name = this.config["imageData"][i].name;

            this.channelTF.push(tf_def);
        }

        // Applying TF to selection, subset, or all
        this.show_subset = false;
        this.show_selection = true;
    }

    /**
     * @function init - initializes OSD, loads metadata, tile drawing, etc.
     */
    init() {
        // Define this as that
        const that = this;

        // Hide Loader
        document.getElementById("openseadragon_loader").style.display = "none";

        // Config viewer
        const viewer_config = {
            id: "openseadragon",
            prefixUrl: "/client/external/openseadragon-bin-2.4.0/openseadragon-flat-toolbar-icons-master/images/",
            maxZoomPixelRatio: 15,
            compositeOperation: "lighter",
            loadTilesWithAjax: true,
            immediateRender: false,
            maxImageCacheCount: 100,
            timeout: 90000,
            collectionMode: false,
            preload: false,
            homeFillsViewer: true,
            visibilityRatio: 1.0,
        };

        // Instantiate viewer with the ViaWebGL Version of OSD
        that.viewer = viaWebGL.OpenSeadragon(viewer_config);

        /************************************************************************************** Get ome tiff metadata */

        dataLayer.getMetadata().then((d) => {
            that.imgMetadata = d;
            console.log("Image metadata:", that.imgMetadata);
            that.addScaleBar();
        });

        // Define interface to shaders
        const seaGL = new viaWebGL.openSeadragonGL(that.viewer);
        this.viaGL = seaGL.viaGL;

        seaGL.viaGL.loadArray = function (w, h, pixels, format = "u16") {
            // Allow for custom drawing in webGL
            var gl = this.gl;

            // Clear before starting all the draw calls
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            // Reset texture for GLSL
            that.selectTexture(gl, this.texture, 0);

            // Send the tile into the texture.
            if (format == "u16") {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8UI, w, h, 0, gl.RG_INTEGER, gl.UNSIGNED_BYTE, pixels);
            } else if (format == "u32") {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, w, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, pixels);
            }

            const iw = this.gl.canvas.width;
            const ih = this.gl.canvas.height;
            this.gl_arguments.tile_ideal_2fv = new Float32Array([iw, ih]);
            this.gl_arguments.tile_real_2fv = new Float32Array([w, h]);

            // Call gl-drawing after loading TEXTURE0
            this["gl-drawing"].call(this);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return gl.canvas;
        };

        seaGL.vShader = "/client/src/shaders/vert.glsl";
        seaGL.fShader = "/client/src/shaders/frag.glsl";

        // Draw handler for viaWebGL
        seaGL.addHandler("tile-drawing", async function (callback, e) {
            // Read parameters from each tile
            const group = e.tile.url.split("/");
            const sub_url = group[group.length - 3];
            const { source } = e.tiledImage;
            const { tileFormat } = source;
            const centerProps = that.selectCenterProps(e.tile, source);

            const via = this.viaGL;

            if (tileFormat != 32) {
                let channel = _.find(that.channelList.currentChannels, (e) => {
                    return e.sub_url == sub_url;
                });
                const color = _.get(channel, "color", d3.color("white"));
                const floatColor = toFloatColor(color);
                const range = _.get(channel, "range", that.dataLayer.getImageBitRange(true));
                // Store channel color and range to send to shader
                via.gl_arguments = {
                    ...centerProps,
                    centers: [],
                    id_end_1i: 0,
                    color_3fv: new Float32Array(floatColor),
                    range_2fv: new Float32Array(range),
                    fmt_1i: 16,
                };
            } else {
                if (!e.tile._array) {
                    console.log("Missing Array", e.tile.url);
                    // this.refreshSegmentationMask();
                }
                const cacheProps = that.getCacheProps();

                // Use new parameters for this tile
                via.gl_arguments = {
                    ...cacheProps,
                    ...centerProps,
                    color_3fv: new Float32Array([1, 1, 1]),
                    range_2fv: new Float32Array([0, 1]),
                    fmt_1i: 32,
                };
            }

            // Clear the rendered tile
            var w = e.rendered.canvas.width;
            var h = e.rendered.canvas.height;
            e.rendered.fillStyle = "black";
            e.rendered.fillRect(0, 0, w, h);

            // Start webGL rendering
            callback(e);
        });

        seaGL.addHandler("gl-drawing", function () {
            const gl_arguments = this.gl_arguments;
            const x_bounds_2fv = gl_arguments.x_bounds_2fv;
            const y_bounds_2fv = gl_arguments.y_bounds_2fv;
            const scale_level_1f = gl_arguments.scale_level_1f;
            const origin_2fv = gl_arguments.origin_2fv;
            const range_2fv = gl_arguments.range_2fv;
            const fmt_1i = gl_arguments.fmt_1i;
            const color_3fv = gl_arguments.color_3fv;
            const id_end_1i = gl_arguments.id_end_1i;
            const tile_ideal_2fv = gl_arguments.tile_ideal_2fv;
            const tile_real_2fv = gl_arguments.tile_real_2fv;
            const modes = that.modeFlags;

            // Send color and range to shader
            this.gl.uniform2fv(this.u_tile_real, tile_real_2fv);
            this.gl.uniform2fv(this.u_tile_ideal, tile_ideal_2fv);
            this.gl.uniform2i(this.u_draw_mode, modes.edge, modes.or);
            this.gl.uniform3fv(this.u_tile_color, color_3fv);
            this.gl.uniform2fv(this.u_tile_range, range_2fv);
            this.gl.uniform2fv(this.u_tile_origin, origin_2fv);
            this.gl.uniform2fv(this.u_x_bounds, x_bounds_2fv);
            this.gl.uniform2fv(this.u_y_bounds, y_bounds_2fv);
            this.gl.uniform1f(this.u_scale_level, scale_level_1f);
            this.gl.uniform1i(this.u_id_end, id_end_1i);
            this.gl.uniform1i(this.u_tile_fmt, fmt_1i);
        });

        seaGL.addHandler("gl-loaded", function (program) {
            // Uniform variables for coloring
            this.u_ids_shape = this.gl.getUniformLocation(program, "u_ids_shape");
            this.u_magnitude_shape = this.gl.getUniformLocation(program, "u_magnitude_shape");
            this.u_center_shape = this.gl.getUniformLocation(program, "u_center_shape");
            this.u_gating_shape = this.gl.getUniformLocation(program, "u_gating_shape");
            this.u_draw_mode = this.gl.getUniformLocation(program, "u_draw_mode");
            this.u_tile_color = this.gl.getUniformLocation(program, "u_tile_color");
            this.u_tile_range = this.gl.getUniformLocation(program, "u_tile_range");
            this.u_tile_origin = this.gl.getUniformLocation(program, "u_tile_origin");
            this.u_x_bounds = this.gl.getUniformLocation(program, "u_x_bounds");
            this.u_y_bounds = this.gl.getUniformLocation(program, "u_y_bounds");
            this.u_scale_level = this.gl.getUniformLocation(program, "u_scale_level");
            this.u_tile_ideal = this.gl.getUniformLocation(program, "u_tile_ideal");
            this.u_tile_real = this.gl.getUniformLocation(program, "u_tile_real");
            this.u_tile_fmt = this.gl.getUniformLocation(program, "u_tile_fmt");
            this.u_id_end = this.gl.getUniformLocation(program, "u_id_end");

            // Texture for colormap
            const u_ids = this.gl.getUniformLocation(program, "u_ids");
            const u_magnitudes = this.gl.getUniformLocation(program, "u_magnitudes");
            const u_centers = this.gl.getUniformLocation(program, "u_centers");
            const u_gatings = this.gl.getUniformLocation(program, "u_gatings");
            this.texture_ids = this.gl.createTexture();
            this.texture_magnitudes = this.gl.createTexture();
            this.texture_centers = this.gl.createTexture();
            this.texture_gatings = this.gl.createTexture();
            this.gl.uniform1i(u_ids, 1);
            this.gl.uniform1i(u_magnitudes, 2);
            this.gl.uniform1i(u_centers, 3);
            this.gl.uniform1i(u_gatings, 4);
        });

        const matchTile = (e, {x, y, level}) => {
            const grid = e.tiledImage.tilesMatrix[level];
            return ((grid || {})[x] || {})[y] || {};
        };

        seaGL.addHandler("tile-loaded", (callback, e) => {
            const { source } = e.tiledImage;
            const { tileFormat } = source;
            try {
                e.tile._blobUrl = e.image?.src;
                if (tileFormat == 32) {
                    e.tile._isLabel = true;
                    if (!e.tile?._array && e.image?._array) {
                        const responseArray = e.tileRequest?.response || e.image._array;
                        const pngBuffer = new Buffer(responseArray);
                        const pngArray = PNG.sync.read(pngBuffer, { colortype: 0 });
                        e.tile._array = new Int32Array(pngArray.data.buffer);
                    }
                }
                // Trigger loading of image
                const tileArgs = [e.tile.level, e.tile.x, e.tile.y];
                const tl = source.toTileLevels(...tileArgs);
                if (tl.imageScale < 1) {
                    const tile = matchTile(e, tl.imageTile);
                    if (tile?._array && tile?._format) {
                        e.tile._format = tile._format;
                        e.tile._array = tile._array;
                    }
                } else {
                    return callback(e);
                }
            } catch (err) {
                console.log("Load Error, Refreshing", err, e.tile.url);
                that.forceRepaint();
            }
        });

        this.viewer.addHandler("tile-drawn", (e) => {
            let count = _.size(e.tiledImage._tileCache._tilesLoaded);
            e.tiledImage._tileCache._imagesLoadedCount = count;
            const canvas = e.eventSource.drawer.canvas;
            const context = canvas.getContext("2d");
            context.mozImageSmoothingEnabled = false;
            context.webkitImageSmoothingEnabled = false;
            context.msImageSmoothingEnabled = false;
            context.imageSmoothingEnabled = false;
        });

        this.viewer.addHandler("tile-unloaded", (e) => {
            if (e.tile._blobUrl) {
                (window.URL || window.webkitURL).revokeObjectURL(e.tile._blobUrl);
            }
            delete e.tile._array;
        });

        // Instantiate viewer managers
        that.viewerManagerVMain = new ViewerManager(that, seaGL.openSD, "main");
        //
        // // Append to viewers
        that.viewerManagers.push(that.viewerManagerVMain);

        seaGL.init();

        this.viewer.scalebar({
            location: 3,
            minWidth: "100px",
            type: "Microscopy",
            stayInsideImage: true,
            pixelsPerMeter: 0,
            fontColor: "rgb(255, 255, 255)",
            color: "rgb(255, 255, 255)",
        });

        // Add listener for scalebar
        const controls_scalebar = document.querySelector("#controls_scalebar");
        controls_scalebar.addEventListener("change", (e) => {
            this.show_scalebar = e.target.checked;
            this.eventHandler.trigger(ImageViewer.events.addScaleBar);
        });

        // Add event mouse handler (cell selection)
        this.viewer.addHandler("canvas-nonprimary-press", function (event) {
            // Right click (cell selection)
            if (event.button === 2) {
                // The canvas-click event gives us a position in web coordinates.
                const webPoint = event.position;
                // Convert that to viewport coordinates, the lingua franca of OpenSeadragon coordinates.
                const viewportPoint = that.viewer.viewport.pointFromPixel(webPoint);
                // Convert from viewport coordinates to image coordinates.
                const imagePoint = that.viewer.world.getItemAt(0).viewportToImageCoordinates(viewportPoint);

                return that.dataLayer.getNearestCell(imagePoint.x, imagePoint.y).then((selectedItem) => {
                    if (selectedItem !== null && selectedItem !== undefined) {
                        // Check if user is doing multi-selection or not
                        let clearPriors = true;
                        if (event.originalEvent.ctrlKey) {
                            clearPriors = false;
                        }
                        // Trigger event
                        that.eventHandler.trigger(ImageViewer.events.imageClickedMultiSel, {
                            selectedItem,
                            clearPriors,
                        });
                    }
                });
            }
        });
    }

    get modeFlags() {
        const edge = this.viewerManagerVMain.sel_outlines;
        const or = csv_gatingList.eval_mode == "or";
        return { edge, or };
    }

    /**
     * Gating Keys for webGL rendering.
     *
     * @type {Array}
     */

    get gatingKeys() {
        const keys = Object.keys(csv_gatingList.selections);
        return keys.sort();
    }

    /**
     * @function toCacheKey -- generate cache keys of gl properties
     * @param idCount - number of active cell ids
     * @param keys - active marker channels
     * @param markerLists - data for each marker
     *
     * @returns {string}
     */
    toCacheKey(idCount, keys, markerLists) {
        const precisions = [2 ** 25, 2 ** 25, 255, 255, 255];
        const tuples = keys.map((channel, i) => {
            const idx = 1 + this.selectMaskIndex(channel);
            const hashes = markerLists[i].map((r, j) => {
                // use precision for each item
                const integral = r * precisions[j];
                return parseInt(integral).toString(36);
            });
            return [idx, ...hashes].join("-");
        });
        return [idCount, ...tuples].join("-");
    }

    /**
     * Cache key for gating webGL buffer.
     *
     * @type {string}
     */

    get fullCacheKey() {
        return this._cacheKeys.full;
    }

    set fullCacheKey(key) {
        this._cacheKeys.full = key;
    }

    /**
     * Cache key for magnitude/center webGL buffers.
     *
     * @type {string}
     */

    get orCacheKey() {
        return this._cacheKeys.or;
    }

    set orCacheKey(key) {
        this._cacheKeys.or = key;
    }

    /**
     * Cache key for most webGL buffers.
     *
     * @type {string}
     */

    get mainCacheKey() {
        return this._cacheKeys.main;
    }

    set mainCacheKey(key) {
        this._cacheKeys.main = key;
    }

    /**
     * @function getCacheProps -- generate cache of gl properties
     *
     * @returns {{
     *  id_end_1i: Number
     * }}
     */
    getCacheProps() {
        const keys = this.gatingKeys;
        const idCount = this.selection.size;
        const { gatings, ranges } = this.selectGatings(keys);
        const changes = this.updateCache(idCount, keys, gatings, ranges);
        const { mainChange, orChange, fullChange } = changes;

        // Bind buffers per-channel
        if (fullChange) {
            const allGatings = [].concat(...gatings);
            this.bindGatings(this.viaGL, allGatings, 5);
        }
        // List cell ids as array
        const needIds = mainChange || orChange;
        const ids = needIds ? [...this.selection.keys()] : [];
        // Bind buffers per-cell
        if (mainChange) {
            this.bindLabels(this.viaGL, ids);
        }
        // Bind or-mode buffers per-cell
        if (orChange && this.modeFlags.or) {
            this.selectCellMagnitudes(ids, keys);
            this.selectCenters(ids);
        }
        return {
            id_end_1i: Math.max(idCount - 1, 0),
        };
    }

    /**
     * @function clearCache -- clear cached props
     *
     * @returns void
     */
    clearCache() {
        this._cacheKeys = {};
    }

    /**
     * @function selectCenters -- return cell centers
     * @param ids - active cell ids
     *
     * @returns {Array}
     */
    selectCenters(ids) {
        const xKey = "X_centroid";
        const yKey = "Y_centroid";

        let centers = [];
        try {
            ids.forEach((id) => {
                const values = this.selection.get(id);
                if (xKey in values && yKey in values) {
                    const center = [values.X_centroid, values.Y_centroid];
                    centers = centers.concat(center);
                } else {
                    throw new TypeError(`Missing "${xKey}" "${yKey}" in selection.`);
                }
            });
        } catch (e) {
            if (e instanceof TypeError) {
                console.warn(e);
                return [];
            }
            throw e;
        }

        if (centers.length) {
            this.bindCenters(this.viaGL, centers);
        }
        return centers;
    }

    /**
     * @function selectCenterProps -- return cell centers properties
     * @param tile - openseadragon tile
     * @param source - openseadragon tile source 
     *
     * @returns {{
     *   scale_level_1f: Number,
     *   x_bounds_2fv: Array,
     *   y_bounds_2fv: Array,
     *   origin_2fv: Array,
     * }}
     */
    selectCenterProps(tile, source) {
        const tileWidth = this.config.tileWidth;
        const tileHeight = this.config.tileHeight;
        const tileArgs = [tile.level, tile.x, tile.y];
        const { imageTile, imageScale } = source.toTileLevels(...tileArgs);
        const origin = [imageTile.x * tileWidth, imageTile.y * tileHeight];
        const bounds = source.toMagnifiedBounds(...tileArgs);

        return {
            scale_level_1f: imageScale,
            x_bounds_2fv: new Float32Array(bounds.x),
            y_bounds_2fv: new Float32Array(bounds.y),
            origin_2fv: new Float32Array(origin),
        };
    }

    /**
     * @function selectCellMagnitudes -- select magnitude ranges
     * @param ids - active cell ids
     * @param keys - active marker channels
     *
     * @returns {Array}
     */
    selectCellMagnitudes(ids, keys) {
        let magnitudes = [];

        try {
            magnitudes = [].concat(
                ...ids.map((id) => {
                    const values = this.selection.get(id);
                    return keys.map((key) => {
                        if (!(key in values)) {
                            throw new TypeError(`Missing "${key}" in selection "${id}".`);
                        }
                        return values[key];
                    });
                })
            );
        } catch (e) {
            if (e instanceof TypeError) {
                console.warn(e);
                return [];
            }
            throw e;
        }

        const keyCount = Math.max(keys.length, 1);
        if (magnitudes.length) {
            this.bindMagnitudes(this.viaGL, magnitudes, keyCount);
        }

        return magnitudes;
    }

    /**
     * @function selectGatings -- select gating ranges
     * @param keys - active marker channels
     *
     * @returns {{ranges: Array, gatings: Array}}
     */
    selectGatings(keys) {
        const ranges = [];
        const gatings = [];
        const gatingRangeMap = csv_gatingList.selections;
        keys.forEach((key) => {
            const range = gatingRangeMap[key].map((x) => parseFloat(x));
            const color = this.selectMaskColor(key);
            const floatColor = toFloatColor(color);
            const gating = range.concat(floatColor);
            gatings.push(gating);
            ranges.push(range);
        });

        return {
            ranges,
            gatings,
        };
    }

    /**
     * @function updateCache -- update cache keys
     * @param idCount - number of active cell ids
     * @param keys - active marker channels
     * @param gatings - cell ranges + colors
     * @param ranges - cell ranges array
     *
     *
     * @returns {{
     *   orChange: boolean,
     *   mainChange: boolean,
     *   fullChange: boolean
     * }}
     */

    updateCache(idCount, keys, gatings, ranges) {
        const mainCacheKey = this.toCacheKey(idCount, keys, ranges);
        const mainChange = this.mainCacheKey !== mainCacheKey;
        if (mainChange) {
            this.mainCacheKey = mainCacheKey;
        }

        const orCacheKey = this.modeFlags.or ? mainCacheKey : null;
        const orChange = this.orCacheKey !== orCacheKey;
        if (orChange) {
            this.orCacheKey = orCacheKey;
        }

        const fullCacheKey = this.toCacheKey(idCount, keys, gatings);
        const fullChange = this.fullCacheKey !== fullCacheKey;
        if (fullChange) {
            this.fullCacheKey = fullCacheKey;
        }

        return { mainChange, fullChange, orChange };
    }

    /**
     * @function selectMaskColor -- select color for mask
     * @param channel - the channel label
     *
     * @returns {{r: Number, g: Number, b: Number}}
     */
    selectMaskColor(channel) {
        const white = {
            r: 255,
            g: 255,
            b: 255,
        };
        if (!channel) {
            return white;
        }
        const channels = channelList.currentChannels;
        const idxString = (this.selectMaskIndex(channel) + 1).toString();
        if (idxString == "0" || !Object.keys(channels).includes(idxString)) {
            return white;
        }
        const data = channels[idxString];
        return data.color;
    }

    /**
     * @function selectMaskIndex -- select index for mask
     * @param channel - the channel label
     *
     * @returns {Number}
     */
    selectMaskIndex(channel) {
        return channelList.columns.indexOf(channel);
    }

    /**
     * @function selectTexture - activate a WebGL texture
     * @param gl - the WebGL2 context
     * @param texture - the WebGL2 texture
     * @param idx - the WebGL2 texture index
     */
    selectTexture(gl, texture, idx) {
        // Set texture for GLSL
        gl.activeTexture(gl["TEXTURE" + idx]);
        gl.bindTexture(gl.TEXTURE_2D, texture), gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        // Assign texture parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    }

    /**
     * @function measureLabelValues - return segmentation mask shape
     * @param gl - the WebGL2 context
     * @param values - the texture data as an array
     *
     * @returns {[width: Number, height: Number]}
     */
    measureLabelValues(gl, values) {
        const width = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const height = Math.ceil(values.length / width);
        return [width, height];
    }

    /**
     * @function packFloat - pack 1D float texture as 2D
     * @param gl - the WebGL2 context
     * @param a - the texture data as an array
     *
     * @returns {{pixels: Uint8Array, width: Number, height: Number}}
     */
    packFloat(gl, a) {
        const [width, height] = this.measureLabelValues(gl, a);
        const pixels = this.packFloat32(a, width, height);
        return { width, height, pixels };
    }

    /**
     * @function packInteger - pack 1D float texture as 2D
     * @param gl - the WebGL2 context
     * @param a - the texture data as an array
     *
     * @returns {{pixels: Uint8Array, width: Number, height: Number}}
     */
    packInteger(gl, a) {
        const [width, height] = this.measureLabelValues(gl, a);
        const pixels = this.packUint8(a, width, height);
        return { width, height, pixels };
    }

    /**
     * @function packFloat32 - pack Float32 Texture
     * @param a - the texture data as an array
     * @param width - the texture width
     * @param height - the texture height
     *
     * @returns {Uint8Array}
     */
    packFloat32(a, width, height) {
        // Create 2D array of pixels
        const full_size = width * height;
        const arr = new ArrayBuffer(4 * full_size);
        const view = new DataView(arr);
        a.forEach((v, i) => {
            view.setFloat32(4 * i, v, true);
        });
        return new Float32Array(arr);
    }

    /**
     * @function packUint8 - pack Uint8 Texture
     * @param a - the texture data as an array
     * @param width - the texture width
     * @param height - the texture height
     *
     * @returns {Uint8Array}
     */
    packUint8(a, width, height) {
        // Create 2D array of pixels
        const full_size = width * height;
        const arr = new ArrayBuffer(4 * full_size);
        const view = new DataView(arr);
        a.forEach((v, i) => {
            view.setUint32(4 * i, v, true);
        });
        return new Uint8Array(arr);
    }

    /**
     * @function setLabelMap - set the segmentation mask ids
     * @param gl - the WebGL2 context
     * @param texture - the WebGL2 texture
     * @param values - the texture data as 2d array
     */
    setLabelMap(gl, texture, values) {
        const packed = this.packInteger(gl, values);
        // Set texture for GLSL
        this.selectTexture(gl, texture, 1);
        // Send an empty array to the texture
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, packed.width, packed.height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, packed.pixels);
    }

    /**
     * @function setMagnitudeMap - set the segmentation mask magnitudes
     * @param gl - the WebGL2 context
     * @param texture - the WebGL2 texture
     * @param values - the texture data as 2d array
     */
    setMagnitudeMap(gl, texture, values) {
        const packed = this.packFloat(gl, values);
        // Set texture for GLSL
        this.selectTexture(gl, texture, 2);
        // Send an empty array to the texture
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, packed.width, packed.height, 0, gl.RED, gl.FLOAT, packed.pixels);
    }

    /**
     * @function setCenterMap - set the segmentation mask centers
     * @param gl - the WebGL2 context
     * @param texture - the WebGL2 texture
     * @param values - the texture data as 2d array
     */
    setCenterMap(gl, texture, values) {
        const packed = this.packInteger(gl, values);
        // Set texture for GLSL
        this.selectTexture(gl, texture, 3);
        // Send an empty array to the texture
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, packed.width, packed.height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, packed.pixels);
    }

    /**
     * @function setGatingMap - set the segmentation mask gatings
     * @param gl - the WebGL2 context
     * @param texture - the WebGL2 texture
     * @param values - the texture data as 2d array
     * @param width - the texture width
     * @param height - the texture height
     */
    setGatingMap(gl, texture, values, width, height) {
        const pixels = this.packFloat32(values, width, height);
        // Set texture for GLSL
        this.selectTexture(gl, texture, 4);
        // Send an empty array to the texture
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, pixels);
    }

    /**
     * @function bindLabels - bind segmentation mask ids
     * @param via - the viaGL context
     * @param values - the texture data as 2d array
     */
    bindLabels(via, values) {
        // Add id mask map
        const ids_2iv = this.measureLabelValues(via.gl, values);
        via.gl.uniform2iv(via.u_ids_shape, ids_2iv);
        this.setLabelMap(via.gl, via.texture_ids, values);
    }

    /**
     * @function bindMagnitudes - bind segmentation mask magnitudes
     * @param via - the viaGL context
     * @param values - the texture data as 2d array
     * @param depth - number of items at each texel
     */
    bindMagnitudes(via, values, depth) {
        // Add a mask magnitude map
        const magnitude_2iv = this.measureLabelValues(via.gl, values);
        const magnitude_3iv = magnitude_2iv.concat(depth);
        via.gl.uniform3iv(via.u_magnitude_shape, magnitude_3iv);
        this.setMagnitudeMap(via.gl, via.texture_magnitudes, values);
    }

    /**
     * @function bindCenters - bind segmentation mask centers
     * @param via - the viaGL context
     * @param values - the texture data as 2d array
     */
    bindCenters(via, values) {
        // Add a mask center map
        const center_2iv = this.measureLabelValues(via.gl, values);
        const center_3iv = center_2iv.concat([2]);
        via.gl.uniform3iv(via.u_center_shape, center_3iv);
        this.setCenterMap(via.gl, via.texture_centers, values);
    }

    /**
     * @function bindGatings - bind segmentation mask gating
     * @param via - the viaGL context
     * @param values - the texture data as 2d array
     * @param width - the texture width
     */
    bindGatings(via, values, width) {
        // Add a mask gating map
        const height = Math.floor(values.length / width);
        const gating_2iv = [width, height];
        via.gl.uniform2iv(via.u_gating_shape, gating_2iv);
        this.setGatingMap(via.gl, via.texture_gatings, values, width, height);
    }

    // =================================================================================================================
    // Tile cache management
    // =================================================================================================================

    /**
     * @function createTFArray - creates an array of colors as a transfer/lookup table for pixel values.
     * @param min the minimum value
     * @param max - the maximum value
     * @param rgb1 - the start color (min)
     * @param rgb2 - the end color (max)
     * @param numBins - the bins for the color interpolation steps
     * @returns {{tf: Array, min: *, max: *, num_bins: *, start_color: *, end_color: *}}
     */
    createTFArray(min, max, rgb1, rgb2, numBins) {
        const tfArray = [];

        const numBinsF = parseFloat(numBins);
        const col1 = d3.rgb(rgb1);
        const col2 = d3.rgb(rgb2);

        for (let i = 0; i < numBins; i++) {
            const rgbTupel = {};
            const lerpFactor = i / (numBinsF - 1.0);

            rgbTupel.r = col1.r + (col2.r - col1.r) * lerpFactor;
            rgbTupel.g = col1.g + (col2.g - col1.g) * lerpFactor;
            rgbTupel.b = col1.b + (col2.b - col1.b) * lerpFactor;

            const lerpCol = d3.rgb(rgbTupel.r, rgbTupel.g, rgbTupel.b);
            tfArray.push(lerpCol);
        }

        return {
            min: min,
            max: max,
            start_color: rgb1,
            end_color: rgb2,
            num_bins: numBins,
            tf: tfArray,
        };
    }

    /**
     * @function actionFocus - sets a viewport based on an action (tool or user driven)
     *
     * @param vp - viewport
     * @returns void
     */
    actionFocus(vp) {
        this.setViewPort(vp.x, vp.y, vp.width, vp.height);
    }

    /**
     * @function setViewPort
     *
     * @param {int} x
     * @param {int} y
     * @param {int} width
     * @param {int} height
     *
     * @returns void
     */
    setViewPort(x, y, width, height) {
        // Calc from main viewer
        const coords = this.viewer.viewport.imageToViewportCoordinates(x, y);
        const lowerBounds = this.viewer.viewport.imageToViewportCoordinates(width, height);
        const box1 = new OpenSeadragon.Rect(coords.x, coords.y, lowerBounds.x, lowerBounds.y);

        // Apply to all viewers
        this.viewerManagers.forEach((vM) => {
            vM.viewer.viewport.fitBounds(box1);
        });
    }

    // =================================================================================================================
    // Rendering
    // =================================================================================================================

    /**
     * @function drawCellRadius - draws a circle with certain radius around a cell
     *
     * @param radius
     * @param selection
     * @param  - whether it fades out
     */
    drawCellRadius(radius, selection, dragging = false) {
        let x = selection[dataLayer.x];
        let y = selection[dataLayer.y];
        let imagePoint = this.viewer.world.getItemAt(0).imageToViewportCoordinates(x, y);
        let circlePoint = this.viewer.world.getItemAt(0).imageToViewportCoordinates(x + _.toNumber(radius), y);
        let viewportRadius = Math.abs(circlePoint.x - imagePoint.x);
        let overlay = seaDragonViewer.viewer.svgOverlay();
        let fade = 0;
        // When dragging the bar, don't fade out
        if (dragging) {
            fade = 1;
        }

        let circle = d3
            .select(overlay.node())
            .selectAll(".radius-circle")
            .interrupt()
            .data([{ x: imagePoint.x, y: imagePoint.y, r: viewportRadius }]);
        circle
            .enter()
            .append("circle")
            .attr("class", "radius-circle")
            .merge(circle)
            .attr("cx", (d) => {
                return d.x;
            })
            .attr("cy", (d) => {
                return d.y;
            })
            .attr("r", (d) => {
                return d.r;
            })
            .style("opacity", 1)
            .transition()
            .duration(1000)
            .ease(d3.easeLinear)
            .style("opacity", fade);
        circle.exit().remove();
    }

    /**Z
     * @function forceRepaint - for all active viewers repaint the canvas
     *
     * @returns void
     */
    forceRepaint() {
        // Trigger change of full cache
        this.fullCacheKey = null;
        // Refilter, redraw
        this.viewerManagers.forEach((vM) => {
            vM.viewer.forceRedraw();
        });
    }

    /**
     * @function updateActiveChannels
     *
     * @param name
     * @param selection
     * @param status
     *
     * @returns void
     */
    updateActiveChannels(name, selection, status) {
        const channelIdx = imageChannels[name];

        if (selection.length === 0) {
            // console.log('nothing selected - keep showing last image');
            // return;
        } else if (selection.length === 1) {
            // console.log('1 channel selected');
        } else {
            // console.log('multiple channels selected');
        }

        if (status) {
            this.viewerManagers.forEach((vM) => {
                vM.channel_add(channelIdx);
            });
        } else {
            this.viewerManagers.forEach((vM) => {
                vM.channel_remove(channelIdx);
            });
        }

        this.forceRepaint();
    }

    /**
     * @function updateChannelRange
     *
     * @param name
     * @param tfmin
     * @param tfmax
     *
     * @returns void
     */
    updateChannelRange(name, tfmin, tfmax) {
        const self = this;
        let range = self.dataLayer.getImageBitRange();
        const channelIdx = imageChannels[name];
        if (self.channelList.currentChannels[channelIdx]) {
            let channelRange = [tfmin / range[1], tfmax / range[1]];
            self.channelList.currentChannels[channelIdx]["range"] = channelRange;
            self.channelList.rangeConnector[channelIdx] = channelRange;
        }
        this.forceRepaint();
    }

    /**
     * @function updateChannelColors
     *
     * @param name
     * @param color
     *
     * @returns void
     */
    updateChannelColors(name, color) {
        const self = this;
        const channelIdx = imageChannels[name];
        if (self.channelList.currentChannels[channelIdx]) {
            self.channelList.colorConnector[channelIdx] = { color: color };
            self.channelList.currentChannels[channelIdx]["color"] = color;
            // self.channelTF[channelIdx].end_color = color;
        }
        this.forceRepaint();
    }

    /**
     * @function updateData
     *
     * @param data
     *
     * @returns void
     */
    updateData(data) {
        this.data = data;
        this.forceRepaint();
    }

    /**
     * @function updateRenderingMode
     *
     * @param mode
     *
     * @returns void
     */
    updateRenderingMode(mode) {
        // Mode is a string: 'show-subset', 'show-selection'
        if (mode === "show-subset") {
            this.show_subset = !this.show_subset;
        }
        if (mode === "show-selection") {
            this.show_selection = !this.show_selection;
        }

        this.forceRepaint();
    }

    /**
     * @function updateSelection
     *
     * @param selection
     * @param repaint
     *
     * @returns void
     */
    updateSelection(selection, repaint = true) {
        this.selection = selection;
        // Reload Label Tiles
        let tileLevels = this.viewer.world.getItemAt(0).tilesMatrix;
        for (const level of Object.values(tileLevels)) {
            for (const tile of Object.values(level)) {
                for (const subTile of Object.values(tile)) {
                    subTile._redrawLabel = true;
                }
            }
        }
        this.viewer.forceRedraw();
        if (repaint) this.forceRepaint();
    }

    addScaleBar() {
        let pixelsPerMeter;
        if (this.show_scalebar) {
            let unitConvert;
            if (this.imgMetadata.physical_size_x_unit === "µm" || this.imgMetadata.physical_size_x_unit === "um") {
                unitConvert = 1000000;
            } else if (this.imgMetadata.physical_size_x_unit === "nm") {
                unitConvert = 1000000000;
            } else if (this.imgMetadata.physical_size_x_unit === "cm") {
                unitConvert = 100;
            } else if (this.imgMetadata.physical_size_x_unit === "m") {
                unitConvert = 1;
            } else {
                unitConvert = 0;
            }
            pixelsPerMeter = unitConvert * this.imgMetadata.physical_size_x;
        } else {
            pixelsPerMeter = 0;
        }

        this.viewer.scalebar({
            pixelsPerMeter: pixelsPerMeter,
        });
    }
}

// Static vars
ImageViewer.events = {
    imageClickedMultiSel: "image_clicked_multi_selection",
    renderingMode: "renderingMode",
    addScaleBar: "addScaleBar",
};

function toFloatColor(color) {
    return [color.r / 255, color.g / 255, color.b / 255];
}
